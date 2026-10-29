'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const native = require('../src/ai/windows-isolation');
const { hash } = require('../src/ai/native-isolation-build');
const { runTerminal } = require('../src/ai/terminal');
const { buildSanitizedEnv } = require('../src/ai/os-isolation');
const real = { skip: process.platform !== 'win32' || !native.getWindowsIsolationStatus().available, timeout: 90000 };
const quote = (s) => "'" + String(s).replaceAll("'", "''") + "'";
const encoded = (s) => Buffer.from(s, 'utf16le').toString('base64');
const source = `using System;using System.Text;using System.Runtime.InteropServices;
public class E3ChildSpawn {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct SI {public int cb;public string reserved,desktop,title;public uint x,y,xSize,ySize,xCount,yCount,fill,flags;public ushort show,cbReserved;public IntPtr reserved2,input,output,error;}
 [StructLayout(LayoutKind.Sequential)]struct PI {public IntPtr process,thread;public uint pid,tid;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder command,IntPtr processAttributes,IntPtr threadAttributes,bool inherit,uint flags,IntPtr environment,string directory,ref SI startup,out PI process);
 [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr VirtualAlloc(IntPtr address,UIntPtr size,uint allocation,uint protect);
 [DllImport("kernel32.dll")]static extern bool VirtualFree(IntPtr address,UIntPtr size,uint kind);
 public static int Start(string script,bool breakaway) {string exe=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\\v1.0\\powershell.exe");SI si=new SI();si.cb=Marshal.SizeOf(typeof(SI));PI pi;if(!CreateProcess(exe,new StringBuilder("\\\""+exe+"\\\" -NoLogo -NoProfile -NonInteractive -EncodedCommand "+script),IntPtr.Zero,IntPtr.Zero,false,0x08000000u|(breakaway?0x01000000u:0u),IntPtr.Zero,Environment.CurrentDirectory,ref si,out pi))return -Marshal.GetLastWin32Error();CloseHandle(pi.thread);CloseHandle(pi.process);return (int)pi.pid;}
 public static bool Memory() {IntPtr p=VirtualAlloc(IntPtr.Zero,new UIntPtr(600u*1024u*1024u),0x3000,4);if(p==IntPtr.Zero)return false;VirtualFree(p,UIntPtr.Zero,0x8000);return true;}
}`;
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e3-lifecycle-test-'));
  const root = path.join(base, 'workspace'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'process.cs'), source);
  const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'canary.txt'), 'DESCENDANT_OUTSIDE_CANARY');
  const acl = spawnSync('icacls.exe', [outside, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '/q'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(acl.status, 0, acl.stderr || acl.stdout);
  return { base, root, cleanup() { assert.equal(fs.realpathSync.native(base), base); assert.ok(path.basename(base).startsWith('codex-e3-lifecycle-test-')); fs.rmSync(base, { recursive: true, force: true }); } };
}
async function run(root, command, options = {}) {
  const sessionKey = 'native-lifecycle';
  const grant = await native.authorizeIsolatedExecution({ projectRoot: root, sessionKey, command, policyLevel: 'workspace-write', confirm: async () => true });
  return runTerminal(root, command, { timeoutMs: 35000, ...options, sessionKey, hostExecutionGrant: grant });
}
function assertDone(result) { assert.equal(result.ok, true, JSON.stringify({ code: result.code, error: result.error, stderr: result.stderr?.slice(0, 4000), cleanupComplete: result.cleanupComplete })); assert.equal(result.isolated, true); assert.equal(result.cleanupComplete, true); assert.equal(result.profileDeleted, true); }
function exists(pid) { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } }
async function waitFor(file) { const end = Date.now() + 15000; while (!fs.existsSync(file)) { if (Date.now() > end) throw new Error('Native child did not produce its fixture: ' + path.basename(file)); await new Promise((r) => setTimeout(r, 50)); } }
function descendants(stay) {
  const grandchild = "$ErrorActionPreference='Stop';$blocked=$false;$readBlocked=$false;try{[IO.File]::WriteAllText('../outside/canary.txt','UNSAFE')}catch{$blocked=$true};try{[IO.File]::ReadAllText('../outside/canary.txt')|Out-Null}catch{$readBlocked=$true};[IO.File]::WriteAllText('boundary.json',([ordered]@{outsideBlocked=$blocked;outsideReadBlocked=$readBlocked}|ConvertTo-Json -Compress));Start-Sleep -Seconds 12;[IO.File]::WriteAllText('late.txt','ORPHAN');Start-Sleep -Seconds 60";
  const child = "$ErrorActionPreference='Stop';try{Add-Type -TypeDefinition ([IO.File]::ReadAllText('process.cs'));$id=[E3ChildSpawn]::Start(" + quote(encoded(grandchild)) + ",$false);if($id -le 0){throw ('grandchild start '+$id)};[IO.File]::WriteAllText('grandchild-pid.txt',[string]$id);Start-Sleep -Seconds 60}catch{[IO.File]::WriteAllText('child-error.txt',$_.ToString());exit 1}";
  return "Add-Type -Path './process.cs';$id=[E3ChildSpawn]::Start(" + quote(encoded(child)) + ",$false);if($id -le 0){throw ('child start '+$id)};[IO.File]::WriteAllText('child-pid.txt',[string]$id);$until=[DateTime]::UtcNow.AddSeconds(15);while(![IO.File]::Exists('boundary.json')){if([IO.File]::Exists('child-error.txt')){throw ([IO.File]::ReadAllText('child-error.txt'))};if([DateTime]::UtcNow -gt $until){throw 'child readiness timeout'};Start-Sleep -Milliseconds 50};" + (stay ? 'Start-Sleep -Seconds 60' : "Write-Output 'descendants-ready'");
}
function assertDescendantsDead(f) {
  const pids = ['child-pid.txt', 'grandchild-pid.txt'].map((file) => Number(fs.readFileSync(path.join(f.root, file), 'utf8')));
  for (const pid of pids) { assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.equal(exists(pid), false, 'A Job descendant survived: ' + pid); }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'boundary.json'), 'utf8')), { outsideBlocked: true, outsideReadBlocked: true });
  assert.equal(fs.readFileSync(path.join(f.base, 'outside', 'canary.txt'), 'utf8'), 'DESCENDANT_OUTSIDE_CANARY'); assert.equal(fs.existsSync(path.join(f.root, 'late.txt')), false);
}

test('E3 native lifecycle: early parent exit kills child and grandchild, with inherited filesystem denial', real, async () => {
  const f = fixture(); try { const result = await run(f.root, descendants(false)); assertDone(result); assertDescendantsDead(f); } finally { f.cleanup(); }
});

test('E3 native lifecycle: cancellation drains the whole Job, including grandchildren', real, async () => {
  const f = fixture(), controller = new AbortController(); let running;
  try { running = run(f.root, descendants(true), { signal: controller.signal }); await waitFor(path.join(f.root, 'boundary.json')); controller.abort(); const result = await running; assert.equal(result.ok, false); assert.equal(result.aborted, true); assert.equal(result.cleanupComplete, true); assert.equal(result.profileDeleted, true); assertDescendantsDead(f); }
  finally { controller.abort(); if (running) await running; f.cleanup(); }
});

test('E3 native lifecycle: launcher crash kills its Job and journal recovery revokes ACL/profile', real, async () => {
  const f = fixture(), controller = new AbortController(); let helperPid, running;
  const jobs = path.join(os.tmpdir(), 'codex-qq-native-' + hash(Buffer.from(os.userInfo().username)).slice(0, 16), 'jobs');
  try {
    running = run(f.root, descendants(true), { signal: controller.signal, onSpawn: (p) => { helperPid = p.helperPid; } });
    await waitFor(path.join(f.root, 'boundary.json')); assert.ok(Number.isSafeInteger(helperPid) && helperPid > 0);
    const journal = fs.readdirSync(jobs).filter((name) => name.endsWith('.json')).map((name) => path.join(jobs, name)).find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).root.toLowerCase() === f.root.toLowerCase());
    assert.ok(journal, 'An active command must have its durable ACL/profile cleanup journal');
    process.kill(helperPid); const result = await running;
    assert.equal(result.ok, false); assert.equal(result.isolated, true); assert.equal(result.executionMode, 'strict-isolated'); assert.equal(result.cleanupComplete, true); assert.equal(result.profileDeleted, true); assert.equal(fs.existsSync(journal), false); assertDescendantsDead(f);
    const acl = spawnSync('icacls.exe', [f.root], { encoding: 'utf8', windowsHide: true }); assert.equal(acl.status, 0); assert.ok(!/S-1-15-2-\d+-\d+/.test(acl.stdout), 'An execution-specific SID remained on the workspace');
  } finally { controller.abort(); if (running) await running; f.cleanup(); }
});

test('E3 native lifecycle: CREATE_BREAKAWAY_FROM_JOB is denied, not silently allowed', real, async () => {
  const f = fixture();
  try { const command = "Add-Type -Path './process.cs';$id=[E3ChildSpawn]::Start(" + quote(encoded('Start-Sleep -Seconds 60')) + ",$true);[ordered]@{code=$id}|ConvertTo-Json -Compress"; const result = await run(f.root, command); assertDone(result); assert.equal(JSON.parse(result.stdout.trim()).code, -5); }
  finally { f.cleanup(); }
});

test('E3 native lifecycle: active process quota refuses a process bomb and leaves no child', real, async () => {
  const f = fixture();
  try {
    const command = "Add-Type -Path './process.cs';$ids=New-Object Collections.Generic.List[int];$denied=0;for($i=0;$i -lt 22;$i++){$id=[E3ChildSpawn]::Start(" + quote(encoded('Start-Sleep -Seconds 60')) + ",$false);if($id -le 0){$denied=$id;break};$ids.Add($id)};[ordered]@{ids=@($ids);denied=$denied}|ConvertTo-Json -Compress";
    const result = await run(f.root, command); assertDone(result); const out = JSON.parse(result.stdout.trim()); assert.ok(out.ids.length > 0 && out.ids.length <= 15, JSON.stringify(out)); assert.ok(out.denied < 0, JSON.stringify(out)); for (const pid of out.ids) assert.equal(exists(pid), false);
  } finally { f.cleanup(); }
});

test('E3 native lifecycle: per-process memory commit cap has an unconfined positive control', real, async () => {
  const f = fixture();
  try {
    const script = 'Add-Type -Path ' + quote(path.join(f.root, 'process.cs')) + ';[E3ChildSpawn]::Memory()|ConvertTo-Json -Compress';
    const ps = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const control = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { encoding: 'utf8', env: buildSanitizedEnv(), windowsHide: true, timeout: 20000 });
    assert.equal(control.status, 0, control.stderr); assert.equal(JSON.parse(control.stdout.trim()), true, 'The host must be able to commit the same 600 MiB request');
    const result = await run(f.root, "Add-Type -Path './process.cs';[E3ChildSpawn]::Memory()|ConvertTo-Json -Compress"); assertDone(result); assert.equal(JSON.parse(result.stdout.trim()), false, 'The 512 MiB process limit must deny the 600 MiB commit');
  } finally { f.cleanup(); }
});
