'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  SECURITY_CODES,
  verifyPathSandbox,
  sanitizePathString,
  buildSanitizedEnv,
  terminateProcessTree,
  checkOutboundPolicy,
  probeIsolationCapabilities,
} = require('../src/ai/os-isolation');

test('E3 OS Isolation - verifyPathSandbox blocks traversal and invalid paths', (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-sandbox-test-'));
  const subDir = path.join(tmpRoot, 'src');
  fs.mkdirSync(subDir);
  const testFile = path.join(subDir, 'index.js');
  fs.writeFileSync(testFile, 'console.log("hello");', 'utf8');

  t.after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch (_) {}
  });

  // 1. Valid internal paths
  const res1 = verifyPathSandbox(tmpRoot, 'src/index.js');
  assert.equal(typeof res1.canonicalTarget, 'string');
  assert.ok(res1.canonicalTarget.toLowerCase().includes('index.js'));

  const res2 = verifyPathSandbox(tmpRoot, '.');
  assert.equal(res2.canonicalRoot.toLowerCase(), res2.canonicalTarget.toLowerCase());

  // 2. Traversal using ..
  assert.throws(
    () => verifyPathSandbox(tmpRoot, '../escaped.txt'),
    (err) => err.code === SECURITY_CODES.TRAVERSAL_DETECTED
  );

  assert.throws(
    () => verifyPathSandbox(tmpRoot, 'src/../../escaped.txt'),
    (err) => err.code === SECURITY_CODES.TRAVERSAL_DETECTED
  );

  // 3. Absolute path outside projectRoot
  const outsidePath = path.resolve(tmpRoot, '..', 'outside.txt');
  assert.throws(
    () => verifyPathSandbox(tmpRoot, outsidePath),
    (err) => err.code === SECURITY_CODES.TRAVERSAL_DETECTED
  );

  // 4. Delete root prevention
  assert.throws(
    () => verifyPathSandbox(tmpRoot, '.', { mode: 'delete' }),
    (err) => err.code === SECURITY_CODES.CANNOT_DELETE_ROOT
  );

  // 5. Windows ADS and device names (on win32)
  if (process.platform === 'win32') {
    assert.throws(
      () => verifyPathSandbox(tmpRoot, 'src/index.js:secret_stream'),
      (err) => err.code === SECURITY_CODES.INVALID_PATH
    );
    assert.throws(
      () => verifyPathSandbox(tmpRoot, 'src/CON.txt'),
      (err) => err.code === SECURITY_CODES.INVALID_PATH
    );
    assert.throws(
      () => verifyPathSandbox(tmpRoot, 'src/NUL'),
      (err) => err.code === SECURITY_CODES.INVALID_PATH
    );
  }

  // 6. Non-existent file creation inside sandbox
  const newFile = verifyPathSandbox(tmpRoot, 'src/new-sub/file.txt', { mode: 'write' });
  assert.ok(newFile.canonicalTarget.toLowerCase().includes('new-sub'));
});

test('E3 OS Isolation - buildSanitizedEnv purges host secrets and cleans PATH', () => {
  // Inject mock secret into current process.env
  process.env.OPENAI_API_KEY = 'sk-test-super-secret-key-123';
  process.env.TEST_AUTH_TOKEN = 'bearer-test-token-456';
  process.env.MY_DATABASE_PASSWORD = 'password123';
  process.env.UNSAFE_CUSTOM_VAR = 'should_not_leak';

  const sanitized = buildSanitizedEnv({
    SAFE_CUSTOM: 'allowed_value',
    ATTEMPT_KEY: 'sk-leaked',
  });

  // Verify secrets are strictly absent
  assert.equal(sanitized.OPENAI_API_KEY, undefined);
  assert.equal(sanitized.TEST_AUTH_TOKEN, undefined);
  assert.equal(sanitized.MY_DATABASE_PASSWORD, undefined);
  assert.equal(sanitized.UNSAFE_CUSTOM_VAR, undefined);
  assert.equal(sanitized.ATTEMPT_KEY, undefined); // stripped because of 'KEY' pattern

  // Verify allowed custom var
  assert.equal(sanitized.SAFE_CUSTOM, 'allowed_value');

  // Verify PATH is cleaned of . and ./
  const rawPath = `C:\\Windows;.;C:\\bin;.\\;`;
  const cleaned = sanitizePathString(rawPath);
  assert.ok(!cleaned.split(path.delimiter).includes('.'));
  assert.ok(!cleaned.split(path.delimiter).includes('.\\'));
  assert.ok(!cleaned.split(path.delimiter).includes(''));

  // Cleanup mock env
  delete process.env.OPENAI_API_KEY;
  delete process.env.TEST_AUTH_TOKEN;
  delete process.env.MY_DATABASE_PASSWORD;
  delete process.env.UNSAFE_CUSTOM_VAR;
});

test('E3 OS Isolation - terminateProcessTree terminates child process', async () => {
  // Spawn a long-running child process
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 500)'], {
    windowsHide: true,
  });

  assert.ok(child.pid > 0);

  // Terminate process tree
  const result = terminateProcessTree(child.pid);
  assert.equal(result.ok, true);

  // Calling terminate on already terminated process should be handled gracefully
  await new Promise((r) => setTimeout(r, 100));
  const resAlreadyDead = terminateProcessTree(child.pid);
  assert.equal(resAlreadyDead.ok, true);
  assert.equal(resAlreadyDead.alreadyExited, true);
});

test('E3 OS Isolation - checkOutboundPolicy enforces network boundaries', () => {
  // Private IPs and metadata must be blocked
  assert.equal(checkOutboundPolicy('http://127.0.0.1:8080').allowed, false);
  assert.equal(checkOutboundPolicy('http://localhost:3000').allowed, false);
  assert.equal(checkOutboundPolicy('http://169.254.169.254/latest/meta-data').allowed, false);
  assert.equal(checkOutboundPolicy('http://192.168.1.1').allowed, false);
  assert.equal(checkOutboundPolicy('http://10.0.0.5').allowed, false);

  // Allowed public URL
  const pub = checkOutboundPolicy('https://api.openai.com/v1/models');
  assert.equal(pub.allowed, true);
});

test('E3 OS Isolation - probeIsolationCapabilities reports truthful status', () => {
  const caps = probeIsolationCapabilities();
  assert.equal(caps.supported, true);
  assert.equal(caps.features.pathSandbox, true);
  assert.equal(caps.features.envSanitization, true);
  assert.equal(caps.features.processTreeTracking, true);
});
