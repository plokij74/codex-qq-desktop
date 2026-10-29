'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const { spawnSync } = require('node:child_process');
const native = require('../src/ai/windows-isolation');
const { runTerminal } = require('../src/ai/terminal');
const { defaultSecretManager } = require('../src/ai/secret-manager');
const available = process.platform === 'win32' && native.getWindowsIsolationStatus().available;
const real = { skip: available ? false : 'Windows verified native build required', timeout: 60000 };
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e3-native-test-'));
  const root = path.join(base, 'workspace'); fs.mkdirSync(root);
  return { base, root, cleanup() {
    assert.equal(fs.realpathSync.native(base), base);
    assert.equal(path.dirname(base), fs.realpathSync.native(os.tmpdir()));
    assert.ok(path.basename(base).startsWith('codex-e3-native-test-'));
    fs.rmSync(base, { recursive: true, force: true });
  } };
}
async function run(root, command, options = {}) {
  const sessionKey = 'native-test-session';
  const grant = await native.authorizeIsolatedExecution({ projectRoot: root, sessionKey, command, cwd: options.cwd, policyLevel: options.policyLevel || 'workspace-write', confirm: async () => true });
  return runTerminal(root, command, { timeoutMs: 20000, ...options, sessionKey, hostExecutionGrant: grant });
}
function succeeded(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.isolated, true); assert.equal(result.executionMode, 'strict-isolated');
  assert.equal(result.networkPolicy, 'deny-all'); assert.equal(result.cleanupComplete, true);
  assert.equal(result.profileDeleted, true);
}
function json(result) { succeeded(result); return JSON.parse(result.stdout.trim()); }
function psAttempts(attempts) {
  return '$ErrorActionPreference="Stop"; $r=[ordered]@{}; ' + Object.entries(attempts).map(([name, body]) =>
    `try { ${body}; $r[${quote(name)}]=$true } catch { $r[${quote(name)}]=$false }`).join('; ') + '; $r | ConvertTo-Json -Compress';
}

test('E3 native: real workspace read/write and outside/userData/vault denial, including broad AAP ACL', real, async () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.root, 'inside.txt'), 'WORKSPACE_CANARY');
    const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
    const userData = path.join(f.base, 'userData'); fs.mkdirSync(userData);
    const other = path.join(f.base, 'other-project'); fs.mkdirSync(other);
    const canary = path.join(outside, 'canary.txt'); fs.writeFileSync(canary, 'OUTSIDE_CANARY');
    const vault = path.join(userData, 'secrets.vault.json'); fs.writeFileSync(vault, 'PRIVATE_VAULT_CANARY');
    const otherFile = path.join(other, 'other.txt'); fs.writeFileSync(otherFile, 'OTHER_PROJECT_CANARY');
    const acl = spawnSync('icacls.exe', [outside, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/q'], { windowsHide: true, encoding: 'utf8' });
    assert.equal(acl.status, 0, acl.stderr || acl.stdout);
    const attempts = {
      insideRead: "if([IO.File]::ReadAllText('inside.txt') -ne 'WORKSPACE_CANARY'){throw 'bad read'}",
      insideWrite: "[IO.File]::WriteAllText('created.txt','WORKSPACE_WRITE'); if([IO.File]::ReadAllText('created.txt') -ne 'WORKSPACE_WRITE'){throw 'bad write'}",
      outsideRead: `[IO.File]::ReadAllText(${quote(canary)}) | Out-Null`,
      outsideWrite: `[IO.File]::WriteAllText(${quote(canary)},'UNSAFE')`,
      vaultRead: `[IO.File]::ReadAllText(${quote(vault)}) | Out-Null`,
      otherRead: `[IO.File]::ReadAllText(${quote(otherFile)}) | Out-Null`,
      outsideCreate: `[IO.Directory]::CreateDirectory(${quote(path.join(outside, 'created'))}) | Out-Null`,
      dotdotRead: "[IO.File]::ReadAllText('../outside/canary.txt') | Out-Null",
    };
    const result = await run(f.root, psAttempts(attempts));
    assert.deepEqual(json(result), { insideRead: true, insideWrite: true, outsideRead: false, outsideWrite: false, vaultRead: false, otherRead: false, outsideCreate: false, dotdotRead: false });
    assert.equal(fs.readFileSync(canary, 'utf8'), 'OUTSIDE_CANARY');
    assert.equal(fs.readFileSync(path.join(f.root, 'created.txt'), 'utf8'), 'WORKSPACE_WRITE');
    assert.ok(!fs.existsSync(path.join(outside, 'created')));
  } finally { f.cleanup(); }
});

test('E3 native: default strict isolation is read-only and caller flags cannot upgrade its grant', real, async () => {
  const f = fixture();
  try {
    const target = path.join(f.root, 'inside.txt'); fs.writeFileSync(target, 'READ_ONLY_CANARY');
    const command = psAttempts({ read: "[IO.File]::ReadAllText('inside.txt') | Out-Null", write: "[IO.File]::WriteAllText('inside.txt','UNSAFE')", create: "[IO.File]::WriteAllText('new.txt','UNSAFE')", delete: "[IO.File]::Delete('inside.txt')" });
    const sessionKey = 'readonly-test'; let confirmedPolicy;
    const grant = await native.authorizeIsolatedExecution({ projectRoot: f.root, sessionKey, command, confirm: async (scope) => { confirmedPolicy = scope.workspacePolicy; return true; } });
    assert.equal(confirmedPolicy, 'read-only');
    const result = await runTerminal(f.root, command, { sessionKey, hostExecutionGrant: grant, policyLevel: 'workspace-write', timeoutMs: 20000 });
    assert.deepEqual(json(result), { read: true, write: false, create: false, delete: false });
    assert.equal(fs.readFileSync(target, 'utf8'), 'READ_ONLY_CANARY'); assert.equal(fs.existsSync(path.join(f.root, 'new.txt')), false);
  } finally { f.cleanup(); }
});

test('E3 native: local TCP, UDP, and unrelated named pipe are denied by the child token', real, async () => {
  const f = fixture(); let tcpConnections = 0, udpPackets = 0, pipeConnections = 0;
  const tcp = net.createServer((socket) => { tcpConnections++; socket.destroy(); });
  const udp = dgram.createSocket('udp4'); udp.on('message', () => { udpPackets++; });
  const pipeName = 'codex-e3-native-' + process.pid + '-' + Date.now();
  const pipe = net.createServer((socket) => { pipeConnections++; socket.destroy(); });
  try {
    await Promise.all([new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve)), new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve)), new Promise((resolve) => pipe.listen('\\\\.\\pipe\\' + pipeName, resolve))]);
    const attempts = {
      tcp: `$c=New-Object Net.Sockets.TcpClient;try{$t=$c.ConnectAsync('127.0.0.1',${tcp.address().port});if(!$t.Wait(1200)){throw 'timeout'};if(!$c.Connected){throw 'not connected'}}finally{$c.Dispose()}`,
      udp: `$u=New-Object Net.Sockets.UdpClient;try{$b=[Text.Encoding]::UTF8.GetBytes('UDP_NATIVE_CANARY');$u.Send($b,$b.Length,'127.0.0.1',${udp.address().port}) | Out-Null}finally{$u.Dispose()}`,
      pipe: `$p=New-Object IO.Pipes.NamedPipeClientStream('.',${quote(pipeName)},[IO.Pipes.PipeDirection]::InOut);try{$p.Connect(700);$p.WriteByte(1)}finally{$p.Dispose()}`,
    };
    assert.deepEqual(json(await run(f.root, psAttempts(attempts))), { tcp: false, udp: false, pipe: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(tcpConnections, 0); assert.equal(udpPackets, 0); assert.equal(pipeConnections, 0);
  } finally {
    await Promise.all([new Promise((resolve) => tcp.close(resolve)), new Promise((resolve) => { try { udp.close(resolve); } catch { resolve(); } }), new Promise((resolve) => pipe.close(resolve))]); f.cleanup();
  }
});

for (const kind of ['junction', 'hardlink', 'ads']) test('E3 native: rejects workspace ' + kind + ' before executing a command', real, async () => {
  const f = fixture();
  try {
    const outside = path.join(f.base, 'outside'); fs.mkdirSync(outside);
    const target = path.join(outside, 'source.txt'); fs.writeFileSync(target, 'PREFLIGHT_CANARY');
    if (kind === 'junction') fs.symlinkSync(outside, path.join(f.root, 'escape'), 'junction');
    if (kind === 'hardlink') fs.linkSync(target, path.join(f.root, 'linked.txt'));
    if (kind === 'ads') { const file = path.join(f.root, 'stream.txt'); fs.writeFileSync(file, 'normal'); fs.writeFileSync(file + ':private', 'ADS_CANARY'); }
    const result = await run(f.root, "[IO.File]::WriteAllText('SHOULD_NOT_EXIST','UNSAFE');Write-Output 'SHOULD_NOT_RUN'");
    assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.isolated, false);
    assert.equal(result.executionMode, 'not-started'); assert.equal(result.cleanupComplete, true);
    assert.equal(fs.existsSync(path.join(f.root, 'SHOULD_NOT_EXIST')), false);
    assert.equal(fs.readFileSync(target, 'utf8'), 'PREFLIGHT_CANARY');
  } finally { f.cleanup(); }
});

test('E3 native: host secrets are not inherited, split output secrets are masked, and injection is denied', real, async () => {
  const f = fixture(); const prefix = 'E3_SYNTHETIC_OUTPUT_', suffix = 'CANARY_019341', secret = prefix + suffix; const old = process.env.OPENAI_API_KEY;
  defaultSecretManager.registerSecret(secret); process.env.OPENAI_API_KEY = secret;
  try {
    const command = `if([Environment]::GetEnvironmentVariable('OPENAI_API_KEY')){throw 'HOST_SECRET_INHERITED'};[Console]::Out.Write(${quote(prefix)});[Console]::Out.Write(${quote(suffix)})`;
    const result = await run(f.root, command); succeeded(result);
    assert.ok(!result.stdout.includes(secret)); assert.ok(!result.command.includes(secret)); assert.match(result.stdout, /\[REDACTED(?::SECRET)?\]/);
    await assert.rejects(run(f.root, 'Write-Output denied', { secretEnv: { SECRET: secret } }), { code: 'ISOLATED_SECRET_INJECTION_UNSUPPORTED' });
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; f.cleanup(); }
});

test('E3 native: bounded output omits the whole payload rather than leaking a truncated secret', real, async () => {
  const f = fixture();
  try { const result = await run(f.root, "[Console]::Out.Write(('x'*22000))"); succeeded(result); assert.equal(result.outputTruncated, true); assert.match(result.stdout, /整体省略/); assert.ok(result.stdout.length < 1000); }
  finally { f.cleanup(); }
});

test('E3 native: timeout terminates the Job and confirms ACL/profile cleanup', real, async () => {
  const f = fixture();
  try { const result = await run(f.root, 'Start-Sleep -Seconds 60', { timeoutMs: 3500 }); assert.equal(result.ok, false); assert.equal(result.timedOut, true); assert.equal(result.code, -1); assert.equal(result.errorCode, 'TIMEOUT'); assert.equal(result.cleanupComplete, true); assert.equal(result.profileDeleted, true); }
  finally { f.cleanup(); }
});

test('E3 native: confirmation grants are exact, single use, and cannot be forged by full-auto flags', real, async () => {
  const f = fixture();
  try {
    const request = { projectRoot: f.root, sessionKey: 'grant-test', command: 'Write-Output grant' };
    await assert.rejects(native.authorizeIsolatedExecution({ ...request, confirm: async () => false }), { code: 'ISOLATED_EXECUTION_REQUIRES_CONFIRMATION' });
    const grant = await native.authorizeIsolatedExecution({ ...request, confirm: async () => true });
    assert.throws(() => runTerminal(f.root, 'Write-Output different', { sessionKey: request.sessionKey, hostExecutionGrant: grant }), { code: 'INVALID_ISOLATED_EXECUTION_GRANT' });
    assert.throws(() => runTerminal(f.root, request.command, { sessionKey: request.sessionKey, hostExecutionGrant: grant }), { code: 'OS_ISOLATION_UNAVAILABLE' });
    assert.throws(() => runTerminal(f.root, request.command, { sessionKey: request.sessionKey, isElevated: true, policyLevel: 'trusted-host', hostExecutionGrant: {} }), { code: 'OS_ISOLATION_UNAVAILABLE' });
  } finally { f.cleanup(); }
});
