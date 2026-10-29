'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'); const os=require('os'); const path=require('path');
const {createPermissionGate,clearSessionAllows}=require('../src/ai/permission');
const {authorizeHostExecution}=require('../src/ai/host-execution');
const {runTerminal}=require('../src/ai/terminal');
const {verifyPathSandbox,sanitizePathString}=require('../src/ai/os-isolation');
function root(t){const p=fs.mkdtempSync(path.join(os.tmpdir(),'e3-gate-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;}
test('E3 actual gate remembers only physical project plus session',async(t)=>{
 clearSessionAllows(); const a=root(t),b=root(t); let prompts=0;
 function gate(projectRoot){let g;g=createPermissionGate({projectRoot,projectId:'same-logical-id',onApprovalNeeded:async e=>{prompts++;g.resolveApproval(e.approvalId,'allow_session');}});return g;}
 const first=gate(a); const args={tool:'write_file',args:{path:'x.txt'},sessionKey:'same-session'};
 assert.equal((await first.authorize(args)).allowed,true); assert.equal((await gate(a).authorize(args)).allowed,true);assert.equal(prompts,1);
 assert.equal((await gate(b).authorize(args)).allowed,true);assert.equal(prompts,2);
 assert.equal((await gate(a).authorize({...args,sessionKey:'new-session'})).allowed,true);assert.equal(prompts,3);
});
test('E3 full auto gate still requires native confirmation each terminal call',async(t)=>{
 const p=root(t);let confirmations=0;
 const gate=createPermissionGate({projectRoot:p,terminalEnabled:true,permissionMode:'full-auto',terminalRequireConfirm:false,requestHostExecution:request=>authorizeHostExecution({...request,confirm:async()=>{confirmations++;return true;}})});
 const req={tool:'run_terminal',args:{command:'Write-Output confirmed'},sessionKey:'s'};
 for(let i=0;i<2;i++){const auth=await gate.authorize(req);assert.equal(auth.allowed,true);const result=await runTerminal(p,req.args.command,{sessionKey:'s',hostExecutionGrant:auth.hostExecutionGrant});assert.equal(result.ok,true);}
 assert.equal(confirmations,2);
});
test('E3 default verification runner requests host confirmation despite preauthorization',async(t)=>{
 const p=root(t); const {createVerificationManager}=require('../src/ai/verification-manager');
 const manager=createVerificationManager({projectPath:p});t.after(()=>manager.close());
 manager.saveProfile(p,{id:'vfy_12345678',name:'Host check',kind:'test',command:'Write-Output verified',cwd:'.',timeoutMs:5000,enabled:true});
 let confirmations=0;
 const gate=createPermissionGate({projectRoot:p,terminalEnabled:true,requestHostExecution:request=>authorizeHostExecution({...request,confirm:async()=>{confirmations++;return true;}})});
 const started=await manager.start({projectPath:p,profileId:'vfy_12345678',settings:{terminalEnabled:true},preAuthorized:true,permissionGate:gate,sessionKey:'verification'});
 assert.equal(started.ok,true);
 const deadline=Date.now()+15000;
 while(['queued','running'].includes(manager.get(started.jobRef)?.status)&&Date.now()<deadline) await new Promise(r=>setTimeout(r,30));
 assert.equal(manager.get(started.jobRef).status,'passed');assert.equal(confirmations,1);
});

test('E3 path validation rejects dangling junction and control characters, permits ..hidden',t=>{
 const p=root(t),missing=path.join(p,'missing');fs.symlinkSync(missing,path.join(p,'dangling'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>verifyPathSandbox(p,'dangling/new.txt'),{code:'SECURITY_INVALID_PATH'});
 assert.throws(()=>verifyPathSandbox(p,'a\nb'),{code:'SECURITY_INVALID_PATH'});
 assert.ok(verifyPathSandbox(p,'..hidden').canonicalTarget.endsWith('..hidden'));
 assert.equal(sanitizePathString(['relative',path.join(p,'Downloads'),p].join(path.delimiter)),p);
});
