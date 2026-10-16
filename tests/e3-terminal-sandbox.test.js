'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { runTerminal, isBlockedCommand } = require('../src/ai/terminal');
const { defaultSecretManager } = require('../src/ai/secret-manager');

test('E3 Terminal Sandbox - runTerminal executes in project workspace and blocks escape', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-term-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  // 1. Legitimate command execution
  const res = await runTerminal(tmpRoot, 'Write-Output "hello-from-terminal"', {
    cwd: tmpRoot,
  });
  assert.equal(res.ok, true);
  assert.ok(res.stdout.includes('hello-from-terminal'));

  // 2. Traversal cwd is blocked
  assert.throws(
    () => runTerminal(tmpRoot, 'Write-Output "escape"', { cwd: path.resolve(tmpRoot, '..') }),
    (err) => /路径越界|终端工作目录必须在项目根目录内/.test(err.message)
  );

  // 3. Dangerous command is blocked
  assert.throws(
    () => runTerminal(tmpRoot, 'shutdown /s /t 0'),
    (err) => /安全策略拦截/.test(err.message)
  );
});

test('E3 Terminal Sandbox - env isolation purges host secrets from child process', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-term-env-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  // Set host secrets
  process.env.TEST_HOST_SECRET_TOKEN = '{{SECRET_d2v2u0cf}}';
  process.env.OPENAI_API_KEY = '{{API_KEY_mfx14k88}}';

  // Execute child process to print environment
  const res = await runTerminal(tmpRoot, 'node -e "console.log(JSON.stringify(process.env))"', {
    cwd: tmpRoot,
  });

  delete process.env.TEST_HOST_SECRET_TOKEN;
  delete process.env.OPENAI_API_KEY;

  assert.equal(res.ok, true);
  const childEnv = JSON.parse(res.stdout.trim());

  // Confirm secrets did NOT leak to child process
  assert.equal(childEnv.TEST_HOST_SECRET_TOKEN, undefined);
  assert.equal(childEnv.OPENAI_API_KEY, undefined);
});

test('E3 Terminal Sandbox - output streaming redacts dynamic registered secrets', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-term-redact-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  defaultSecretManager.registerSecret('top-secret-val-98765', 'TEST_VAL');

  let streamedOutput = '';
  const res = await runTerminal(tmpRoot, 'Write-Output "Token is top-secret-val-98765 end"', {
    cwd: tmpRoot,
    onStdout: (chunk) => {
      streamedOutput += chunk;
    },
  });

  assert.equal(res.ok, true);
  // Both final stdout and streamed stdout must be redacted
  assert.ok(res.stdout.includes('[REDACTED:TEST_VAL]'));
  assert.ok(!res.stdout.includes('top-secret-val-98765'));
  assert.ok(streamedOutput.includes('[REDACTED:TEST_VAL]'));
  assert.ok(!streamedOutput.includes('top-secret-val-98765'));
});

test('E3 Terminal Sandbox - abort signal terminates child process tree', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-term-abort-test-'));

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  const controller = new AbortController();

  setTimeout(() => {
    controller.abort();
  }, 200);

  const res = await runTerminal(tmpRoot, 'Start-Sleep -Seconds 10', {
    cwd: tmpRoot,
    signal: controller.signal,
  });

  assert.equal(res.ok, false);
  assert.equal(res.aborted, true);
});
