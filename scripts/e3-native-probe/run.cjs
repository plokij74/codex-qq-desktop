'use strict';
// Opt-in native feasibility checks. This is not the production isolation backend.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (!process.argv.includes('--run')) {
  console.log('Usage: node scripts/e3-native-probe/run.cjs --run [--inject-failure]');
  console.log('Windows only. Creates temporary AppContainer profiles, ACL grants on fresh temporary files, and a loopback listener. Retains evidence. Never enables production isolation.');
  process.exit(2);
}
if (process.platform !== 'win32') throw new Error('This probe requires Windows.');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(compiler)) throw new Error('Existing Framework64 C# compiler not found; nothing will be installed.');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e3-native-build-'));
const binary = path.join(root, 'Probe.exe');
const fixture = path.join(root, 'provider.ps1');
fs.copyFileSync(path.join(__dirname, 'provider.ps1'), fixture);
const injected = process.argv.includes('--inject-failure');
if (injected) {
  fs.appendFileSync(fixture, "\n[IO.File]::AppendAllText(($Work + '\\provider-results.txt'), \"provider-bootstrap=FAIL`r`n\")\nexit 1\n");
}
const log = path.join(root, 'run.log');
const fd = fs.openSync(log, 'w');
let result;
try {
  const build = spawnSync(compiler, ['/nologo', '/utf8output', '/out:' + binary, path.join(__dirname, 'Probe.cs')], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 30000 });
  if (build.error || build.status !== 0) throw build.error || new Error('Native probe compilation failed; see ' + log);
  result = spawnSync(binary, [fixture, process.execPath, path.join(__dirname, 'node-fixture.cjs')], { stdio: ['ignore', fd, fd], windowsHide: true, timeout: 120000 });
} finally { fs.closeSync(fd); }
const text = fs.readFileSync(log, 'utf8');
const checks = [...text.matchAll(/^CHECK ([a-z-]+)=(PASS|FAIL)\r?$/gm)].map((m) => ({ name: m[1], passed: m[2] === 'PASS' }));
const evidence = /^EVIDENCE (.+)\r?$/m.exec(text)?.[1]?.trim();
const summary = {
  productionIsolationAvailable: false,
  scope: 'AppContainer provider IO, outside canary and static junction denial, IPv4 loopback denial, basic descendant cleanup',
  injectedFailure: injected,
  exitCode: result.status,
  error: result.error?.message || null,
  checks,
  evidence,
  log,
};
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
// Do not infer successful confinement from a zero native exit alone.
const required = ['provider-exit','provider-bootstrap','native-nested-cwd','provider-outside-read-denied','provider-outside-write-denied','dotnet-outside-read-denied','dotnet-outside-write-denied','descendant-parent-exit','descendant-cleaned','host-loopback-positive','managed-exit','managed-inside-write','managed-outside-read-denied','managed-outside-write-denied','loopback-denied','outside-canary-unchanged','profile-deleted','junction-host-positive','junction-provider-read-denied','junction-provider-write-denied','junction-dotnet-read-denied','junction-dotnet-write-denied','junction-canary-unchanged','host-env-positive','managed-env-clean','managed-temp-private'];
const complete = required.every((name) => checks.filter((c) => c.name === name).length === 1 && checks.find((c) => c.name === name).passed);
process.exitCode = result.error || result.status !== 0 || !complete || checks.some((c) => !c.passed) ? 1 : 0;
