'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dgram = require('node:dgram');
const { spawn } = require('node:child_process');
const native = require('../src/ai/windows-isolation');
const { runTerminal } = require('../src/ai/terminal');
const { buildSanitizedEnv } = require('../src/ai/os-isolation');
// Documented DnsQueryEx + explicit DNS_ADDR_ARRAY: the receiver is local and
// both the positive control and LPAC query bypass hosts/cache. NXDOMAIN alone
// is not denial evidence; the receiver packet count and API errors are checked.
const source = `using System;using System.Runtime.InteropServices;
public class E3DnsControl {
 [StructLayout(LayoutKind.Sequential)]struct Request {public uint version;public IntPtr name;public ushort type;public ulong options;public IntPtr servers;public uint index;public IntPtr callback,context;}
 [StructLayout(LayoutKind.Sequential)]struct Result {public uint version;public int status;public ulong options;public IntPtr records,reserved;}
 [DllImport("dnsapi.dll")]static extern int DnsQueryEx(ref Request request,ref Result result,IntPtr cancel);
 [DllImport("dnsapi.dll")]static extern void DnsRecordListFree(IntPtr records,int type);
 public static int[] Query(string name,int port) {
  IntPtr servers=Marshal.AllocHGlobal(96),queryName=Marshal.StringToHGlobalUni(name);
  Result result=new Result();result.version=1;
  try {
   for(int i=0;i<96;i++)Marshal.WriteByte(servers,i,0);
   Marshal.WriteInt32(servers,0,96);Marshal.WriteInt32(servers,4,1);Marshal.WriteInt16(servers,12,2);
   Marshal.WriteInt16(servers,32,2);Marshal.WriteByte(servers,34,(byte)(port>>8));Marshal.WriteByte(servers,35,(byte)port);
   Marshal.WriteByte(servers,36,127);Marshal.WriteByte(servers,39,1);
   Request request=new Request();request.version=1;request.name=queryName;request.type=1;request.options=0x48;request.servers=port==0?IntPtr.Zero:servers;
   int status=DnsQueryEx(ref request,ref result,IntPtr.Zero);return new int[]{status,result.status};
  }finally{if(result.records!=IntPtr.Zero)DnsRecordListFree(result.records,1);Marshal.FreeHGlobal(servers);Marshal.FreeHGlobal(queryName);}
 }
}`;
function command(name, port) { return "$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n" + source + "\n'@;$v=[E3DnsControl]::Query('" + name + "'," + port + ");[ordered]@{returnCode=$v[0];queryStatus=$v[1]}|ConvertTo-Json -Compress"; }
function hostControl(script) {
  return new Promise((resolve, reject) => {
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: buildSanitizedEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); }); child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => child.kill(), 20000);
    child.on('error', reject); child.on('close', (code) => { clearTimeout(timer); if (code !== 0) reject(new Error('DNS positive control failed: ' + stderr)); else { try { resolve(JSON.parse(stdout.trim())); } catch (e) { reject(e); } } });
  });
}
test('E3 native DNS: controlled DnsQueryEx receiver sees host control but no LPAC query', { skip: process.platform !== 'win32' || !native.getWindowsIsolationStatus().available, timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e3-dns-test-'));
  const receiver = dgram.createSocket('udp4'); const packets = [];
  receiver.on('message', (message, remote) => {
    packets.push(message.toString('hex'));
    const response = Buffer.from(message); response.writeUInt16BE(0x8183, 2); response.writeUInt16BE(0, 6); response.writeUInt16BE(0, 8);
    receiver.send(response, remote.port, remote.address);
  });
  try {
    await new Promise((resolve, reject) => { receiver.once('error', reject); receiver.bind(0, '127.0.0.1', resolve); });
    const port = receiver.address().port;
    const control = await hostControl(command('host-' + Date.now() + '.e3.invalid.', port));
    assert.ok(packets.length > 0, 'The positive control must actually send a DNS wire packet: ' + JSON.stringify(control));
    assert.ok(control.returnCode === 0 || control.returnCode === 9003, JSON.stringify(control));
    const before = packets.length, script = command('lpac-' + Date.now() + '.e3.invalid.', port), sessionKey = 'controlled-dns';
    const grant = await native.authorizeIsolatedExecution({ projectRoot: root, command: script, sessionKey, confirm: async () => true });
    const result = await runTerminal(root, script, { sessionKey, hostExecutionGrant: grant, timeoutMs: 25000 });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.isolated, true);
    const denied = JSON.parse(result.stdout.trim());
    assert.equal(packets.length, before, 'An LPAC DNS packet escaped to the controlled receiver: ' + JSON.stringify(denied));
    const afterControl = await hostControl(command('host-after-' + Date.now() + '.e3.invalid.', port));
    assert.ok(packets.length > before, 'The receiver must still accept a host wire packet after the isolated attempt');
    assert.ok(afterControl.returnCode === 0 || afterControl.returnCode === 9003, JSON.stringify(afterControl));
    // WFP can silently discard an unauthorized lowbox UDP send. ERROR_TIMEOUT
    // is accepted only with zero received packets AND successful wire controls
    // both before and after; an isolated timeout/NXDOMAIN alone never passes.
    assert.ok([5, 10013, 1460].includes(denied.returnCode) || [5, 10013, 1460].includes(denied.queryStatus), 'Unexpected DNS result: ' + JSON.stringify(denied));
    t.diagnostic(JSON.stringify({ api: 'DnsQueryEx/no-cache/no-hosts', beforeControl: control, isolated: denied, isolatedPackets: 0, afterControl, hostPackets: packets.length }));
    assert.equal(result.cleanupComplete, true); assert.equal(result.profileDeleted, true);
  } finally {
    await new Promise((resolve) => { try { receiver.close(resolve); } catch { resolve(); } });
    assert.equal(fs.realpathSync.native(root), root); assert.ok(path.basename(root).startsWith('codex-e3-dns-test-')); fs.rmSync(root, { recursive: true, force: true });
  }
});

// This acceptance probe is explicit opt-in: ordinary offline regression must
// not depend on a public resolver. Synthetic names carry no workspace data.
test('E3 native DNS: default resolver and .NET DNS refuse resolution with host-positive controls', { skip: process.platform !== 'win32' || !native.getWindowsIsolationStatus().available || process.env.E3_RUN_SYSTEM_DNS_PROBE !== '1', timeout: 120000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-e3-default-dns-test-'));
  function probe(name) {
    return "$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n" + source + "\n'@;$v=[E3DnsControl]::Query('" + name + "-api.127.0.0.1.nip.io.',0);$addresses=@();$netError=0;try{$addresses=@([Net.Dns]::GetHostAddresses('" + name + "-net.127.0.0.1.nip.io.')|ForEach-Object{$_.IPAddressToString})}catch{$netError=[int]$_.Exception.InnerException.ErrorCode};[ordered]@{returnCode=$v[0];queryStatus=$v[1];addresses=$addresses;dotNetError=$netError}|ConvertTo-Json -Compress";
  }
  try {
    const nonce = Date.now().toString(36);
    const before = await hostControl(probe('host-before-' + nonce));
    assert.equal(before.returnCode, 0, 'Default-resolver positive control must resolve: ' + JSON.stringify(before)); assert.ok(before.addresses.includes('127.0.0.1'), JSON.stringify(before));
    const script = probe('lpac-' + nonce), sessionKey = 'default-dns-probe';
    const grant = await native.authorizeIsolatedExecution({ projectRoot: root, command: script, sessionKey, confirm: async () => true });
    const result = await runTerminal(root, script, { sessionKey, hostExecutionGrant: grant, timeoutMs: 35000 });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.isolated, true);
    const denied = JSON.parse(result.stdout.trim());
    const after = await hostControl(probe('host-after-' + nonce));
    assert.equal(after.returnCode, 0, 'The host DNS control must still resolve after LPAC execution: ' + JSON.stringify(after)); assert.ok(after.addresses.includes('127.0.0.1'), JSON.stringify(after));
    // 9852 is DNS_ERROR_NO_DNS_SERVERS: resolver configuration is unavailable
    // in this lowbox, not a successful DNS response. This is accepted only
    // with successful before/after controls for BOTH APIs. The separate local
    // receiver test independently proves zero unauthorized DNS wire packets.
    assert.ok([5, 10013, 1460, 9852].includes(denied.returnCode), JSON.stringify(denied));
    assert.equal(denied.addresses.length, 0, 'The .NET default resolver returned a DNS address in LPAC'); assert.ok(denied.dotNetError !== 0, JSON.stringify(denied));
    assert.equal(result.cleanupComplete, true); assert.equal(result.profileDeleted, true);
    t.diagnostic(JSON.stringify({ scope: 'Synthetic public wildcard/no user data', before, isolated: denied, after }));
  } finally { assert.equal(fs.realpathSync.native(root), root); assert.ok(path.basename(root).startsWith('codex-e3-default-dns-test-')); fs.rmSync(root, { recursive: true, force: true }); }
});
