'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  ExecutionPolicyLevel,
  ScopedSessionStore,
  evaluateToolExecution,
} = require('../src/ai/execution-policy');

test('E3 ExecutionPolicy - ScopedSessionStore enforces cross-project permission isolation', () => {
  const store = new ScopedSessionStore();

  // Grant in Project 1
  store.grant('project-1', 'session-alpha', 'terminal');
  store.grant('project-1', 'session-alpha', 'write');

  // Verify granted in project 1
  assert.equal(store.isGranted('project-1', 'session-alpha', 'terminal'), true);
  assert.equal(store.isGranted('project-1', 'session-alpha', 'write'), true);

  // Cross-project leak prevention: MUST NOT be granted in project 2!
  assert.equal(store.isGranted('project-2', 'session-alpha', 'terminal'), false);
  assert.equal(store.isGranted('project-2', 'session-alpha', 'write'), false);

  // Cross-session leak prevention: MUST NOT be granted in different session
  assert.equal(store.isGranted('project-1', 'session-beta', 'terminal'), false);

  // Revoke specific risk in project 1
  store.revoke('project-1', 'session-alpha', 'terminal');
  assert.equal(store.isGranted('project-1', 'session-alpha', 'terminal'), false);
  assert.equal(store.isGranted('project-1', 'session-alpha', 'write'), true);
});

test('E3 ExecutionPolicy - evaluateToolExecution blocks traversal and SSRF under STRICT_ISOLATED', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-policy-test-'));
  const srcDir = path.join(tmpRoot, 'src');
  fs.mkdirSync(srcDir);
  const testFile = path.join(srcDir, 'app.js');
  fs.writeFileSync(testFile, 'console.log(1)', 'utf8');

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  const ctx = {
    projectRoot: tmpRoot,
    projectId: 'test-proj',
    sessionKey: 'sess-1',
    policyLevel: ExecutionPolicyLevel.STRICT_ISOLATED,
  };

  // 1. Safe internal file read
  const evalReadOk = evaluateToolExecution('read_file', { path: 'src/app.js' }, ctx);
  assert.equal(evalReadOk.allowed, true);

  // 2. Traversal file read
  const evalReadEscape = evaluateToolExecution('read_file', { path: '../outside.txt' }, ctx);
  assert.equal(evalReadEscape.allowed, false);
  assert.equal(evalReadEscape.requiresElevation, true);
  assert.equal(evalReadEscape.code, 'SECURITY_TRAVERSAL_DETECTED');

  // 3. Traversal terminal cwd
  const evalTerminalEscape = evaluateToolExecution('run_terminal', { cwd: '..' }, ctx);
  assert.equal(evalTerminalEscape.allowed, false);
  assert.equal(evalTerminalEscape.requiresElevation, true);

  // 4. SSRF / Private network fetch
  const evalNetSsrf = evaluateToolExecution('web_fetch', { url: 'http://169.254.169.254/latest' }, ctx);
  assert.equal(evalNetSsrf.allowed, false);
  assert.equal(evalNetSsrf.requiresElevation, true);

  // 5. Host unconfined elevation allows outside execution when explicitly elevated
  const elevatedCtx = {
    ...ctx,
    policyLevel: ExecutionPolicyLevel.HOST_UNCONFINED,
    isElevated: true,
  };
  const evalElevated = evaluateToolExecution('read_file', { path: '../outside.txt' }, elevatedCtx);
  assert.equal(evalElevated.allowed, true);
  assert.equal(evalElevated.elevated, true);
});
