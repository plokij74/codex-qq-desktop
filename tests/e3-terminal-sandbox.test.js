'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { runTerminal } = require('../src/ai/terminal');
const { authorizeHostExecution } = require('../src/ai/host-execution');
const { SecretManager, redactSecrets, createSecretOutputBuffer } = require('../src/ai/secret-manager');
const { verifyPathSandbox } = require('../src/ai/os-isolation');
function temp(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e3-real-')); t.after(() => fs.rmSync(root, {recursive:true,force:true})); return root; }
async function granted(root, command, opts = {}) {
  const sessionKey = 'e3-session';
  const hostExecutionGrant = await authorizeHostExecution({ projectRoot:root, command, cwd:opts.cwd, sessionKey, signal:opts.signal, secretEnv:opts.secretEnv, confirm: async request => { assert.equal(request.isolated,false); return true; } });
  return runTerminal(root, command, { ...opts, sessionKey, hostExecutionGrant });
}
test('E3 terminal fails closed for every policy and forged boolean grants', (t) => {
  const root = temp(t);
  for (const policyLevel of ['strict-isolated','workspace-write','host-unconfined','HOST_UNCONFINED']) {
    assert.throws(() => runTerminal(root, 'Write-Output denied', {policyLevel,isElevated:true,hostExecutionGrant:{}}), {code:'OS_ISOLATION_UNAVAILABLE'});
  }
});
test('E3 host grant is confirmed, scoped and single use', async (t) => {
  const root=temp(t); const command='Write-Output hello'; const request={projectRoot:root,sessionKey:'s',command,confirm:async()=>true};
  await assert.rejects(authorizeHostExecution({...request,confirm:async()=>false}),{code:'OS_ISOLATION_UNAVAILABLE'});
  const grant=await authorizeHostExecution(request);
  assert.throws(()=>runTerminal(root,command,{sessionKey:'other',hostExecutionGrant:grant}),{code:'OS_ISOLATION_UNAVAILABLE'});
  const valid=await authorizeHostExecution(request);
  const result=await runTerminal(root,command,{sessionKey:'s',hostExecutionGrant:valid});
  assert.equal(result.ok,true); assert.equal(result.isolated,false); assert.equal(result.executionMode,'host-unconfined');
  assert.throws(()=>runTerminal(root,command,{sessionKey:'s',hostExecutionGrant:valid}),{code:'OS_ISOLATION_UNAVAILABLE'});
});
test('E3 real junction blocks external read/write targets', (t) => {
  const root=temp(t), outside=temp(t); fs.writeFileSync(path.join(outside,'secret.txt'),'fixture');
  fs.symlinkSync(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
  for(const target of ['link/secret.txt','link/new.txt']) assert.throws(()=>verifyPathSandbox(root,target,{mode:'write'}),{code:'SECURITY_TRAVERSAL_DETECTED'});
});
test('E3 independent vault registrations and arbitrary split UTF8 output redact globally', (t) => {
  const manager=new SecretManager({userDataPath:temp(t),useSafeStorage:false});
  manager.setSecret('opaque','arbitrary-credential-你好-789');
  assert.ok(!redactSecrets({message:'arbitrary-credential-你好-789'}).message.includes('arbitrary-credential'));
  let published=''; const buffer=createSecretOutputBuffer(s=>published+=s);
  for(const byte of Buffer.from('prefix arbitrary-credential-你好-789 suffix')) buffer.write(Buffer.from([byte]));
  assert.equal(published,''); buffer.flush(); assert.ok(published.includes('[REDACTED:opaque]'));
});
test('E3 actual child environment drops secrets and injects only approved names', async(t)=>{
  const root=temp(t); process.env.E3_HOST_TOKEN='do-not-inherit'; t.after(()=>delete process.env.E3_HOST_TOKEN);
  const result=await granted(root,'Write-Output ($null -eq $env:E3_HOST_TOKEN); Write-Output $env:E3_OPERATION_TOKEN', {secretEnv:{E3_OPERATION_TOKEN:'explicitly-granted-987654'},env:{ATTACK_TOKEN:'blocked'},allowSecrets:true});
  assert.equal(result.ok,true); assert.match(result.stdout,/True/); assert.match(result.stdout,/REDACTED:E3_OPERATION_TOKEN/); assert.ok(!result.stdout.includes('explicitly-granted'));
});
for (const mode of ['abort','timeout']) test(`E3 actual grandchild is gone after ${mode}`,async(t)=>{
  const root=temp(t); const pidFile=path.join(root,'pids.json');
  const script=path.join(root,'tree.cjs');
  fs.writeFileSync(script,`const fs=require('fs');const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`);
  const command=`& '${process.execPath.replace(/'/g,"''")}' '${script.replace(/'/g,"''")}'`;
  const controller=new AbortController();
  let pids=[];
  const timer=setInterval(()=>{ if(fs.existsSync(pidFile)){pids=JSON.parse(fs.readFileSync(pidFile,'utf8')); if(mode==='abort') controller.abort();}},30);
  t.after(()=>clearInterval(timer));
  const result=await granted(root,command,{signal:controller.signal,timeoutMs:mode==='timeout'?2500:10000});
  clearInterval(timer); if(!pids.length&&fs.existsSync(pidFile)) pids=JSON.parse(fs.readFileSync(pidFile,'utf8'));
  assert.equal(pids.length,2); assert.equal(mode==='abort'?result.aborted:result.timedOut,true);
  for(const pid of pids) assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
});
