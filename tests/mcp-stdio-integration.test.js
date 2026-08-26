'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMcpHub } = require('../src/ai/mcp-hub');
const { createMcpSessionManager } = require('../src/ai/mcp-session-manager');
const { createMcpSamplingController } = require('../src/ai/mcp-sampling');
const { createPermissionGate } = require('../src/ai/permission');

function launchCount(logPath) {
  if (!fs.existsSync(logPath)) return 0;
  return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).length;
}

function probePayload(callResult) {
  assert.equal(callResult.ok, true);
  const toolResult = JSON.parse(callResult.result);
  return JSON.parse(toolResult.content[0].text);
}

describe('D9 real stdio MCP integration', () => {
  it('covers prompts, roots, approved sampling, reuse, reconnect, and reset', { timeout: 20_000 }, async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-d9-stdio-'));
    const projectPath = path.join(tempRoot, 'project');
    const launchLog = path.join(tempRoot, 'launches.jsonl');
    const serverPath = path.join(__dirname, 'fixtures', 'mcp-stdio-server.js');
    fs.mkdirSync(projectPath);

    const manager = createMcpSessionManager({ idleMs: 60_000 });
    const hub = createMcpHub({ sessionManager: manager });
    const serverConfig = {
      name: 'smoke',
      command: process.execPath,
      args: [serverPath, launchLog],
      sessionRecovery: true,
      sampling: { enabled: true },
    };

    function contextFor(label) {
      const approvals = [];
      let gate;
      gate = createPermissionGate({
        permissionMode: 'full-auto',
        onApprovalNeeded(payload) {
          approvals.push(payload);
          setImmediate(() => gate.resolveApproval(payload.approvalId, 'allow'));
        },
      });
      const sampling = createMcpSamplingController({
        settings: { mode: 'api', baseUrl: 'https://api.invalid', model: 'smoke-model', usagePricing: [] },
        gate,
        sessionKey: label,
        serverConfig: () => serverConfig,
        chatFn: async () => ({
          role: 'assistant',
          content: `approved-${label}`,
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        }),
      });
      return {
        approvals,
        context: {
          cwd: projectPath,
          project: { name: 'Smoke project', path: projectPath },
          samplingHandler: (server, params, signal) => sampling.createMessage(server, params, signal),
        },
      };
    }

    try {
      const run1 = contextFor('run-1');
      await hub.startAll([serverConfig], run1.context);
      const toolNames = hub.getToolDefs().map((item) => item.function.name);
      assert.ok(toolNames.includes('mcp_smoke_probe'));
      assert.ok(toolNames.includes('mcp_prompts_list'));

      const prompts = await hub.listPrompts('smoke');
      assert.equal(prompts.ok, true);
      assert.equal(prompts.prompts[0].name, 'smoke_prompt');
      const prompt = await hub.getPrompt('smoke', 'smoke_prompt', { value: 'one' });
      assert.equal(prompt.ok, true);
      assert.equal(prompt.text, 'user: prompt:one');

      const resource = await hub.call('mcp_resource_read', { server: 'smoke', uri: 'smoke://resource' });
      assert.equal(resource.ok, true);
      assert.match(resource.contents, /stdio resource content/);

      const firstProbe = probePayload(await hub.call('mcp_smoke_probe', {}));
      assert.equal(firstProbe.cwd, projectPath);
      assert.deepEqual(firstProbe.initializeCapabilities.roots, { listChanged: true });
      assert.deepEqual(firstProbe.initializeCapabilities.sampling, {});
      assert.equal(firstProbe.roots.roots[0].name, 'Smoke project');
      assert.equal(firstProbe.roots.roots[0].uri, pathToFileURL(fs.realpathSync(projectPath)).href);
      assert.equal(firstProbe.sampling.content, 'approved-run-1');
      assert.equal(run1.approvals.length, 1);
      assert.equal(run1.approvals[0].source, 'mcp-sampling');
      assert.equal(run1.approvals[0].server, 'smoke');
      await hub.stopAll();
      assert.equal(manager.status('smoke')[0].state, 'idle');
      assert.equal(launchCount(launchLog), 1);

      const run2 = contextFor('run-2');
      await hub.startAll([serverConfig], run2.context);
      const secondProbe = probePayload(await hub.call('mcp_smoke_probe', {}));
      assert.equal(secondProbe.pid, firstProbe.pid);
      assert.equal(secondProbe.sampling.content, 'approved-run-2');
      assert.equal(run2.approvals.length, 1);
      assert.equal(launchCount(launchLog), 1);

      const crash = await hub.call('mcp_smoke_crash', {});
      assert.equal(crash.ok, false);
      assert.equal(manager.status('smoke')[0].state, 'error');
      await hub.stopAll();

      const run3 = contextFor('run-3');
      await hub.startAll([serverConfig], run3.context);
      const recoveredProbe = probePayload(await hub.call('mcp_smoke_probe', {}));
      assert.notEqual(recoveredProbe.pid, firstProbe.pid);
      assert.equal(recoveredProbe.sampling.content, 'approved-run-3');
      assert.equal(launchCount(launchLog), 2);
      await hub.stopAll();

      assert.equal(await manager.reset('smoke', 'stdio-smoke-reset'), 1);
      assert.deepEqual(manager.status('smoke'), []);
    } finally {
      await hub.close();
      await manager.closeAll();
      await fs.promises.rm(tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  });
});
