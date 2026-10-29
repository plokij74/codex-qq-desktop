'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { PlanStateManager } = require('../src/ai/plan-state');
const schema = require('../src/ai/message-schema');
const helper = require('../src/renderer/e2-messages');
const { defaultSecretManager } = require('../src/ai/secret-manager');
const { TaskHandle, createTaskEventEnvelope } = require('../src/ai/task-contract');
function binding(dir) { return { sessionId: 's', projectId: 'p', projectPath: dir, projectBindingId: 'bind', senderId: 42 }; }
test('plan real binding rejects sender/project/session replay; atomic claim rolls back and cannot replay', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-plan-')); t.after(() => fs.rmSync(dir, {recursive:true,force:true}));
  const b = binding(dir), m = new PlanStateManager(); m.propose({...b,planId:'p1',markdown:'go'});
  for (const key of ['sessionId','projectId','projectBindingId','senderId']) assert.throws(() => m.claimApprove('p1',{...b,[key]:'other'}),{code:'PLAN_BINDING_CHANGED'});
  const claim=m.claimApprove('p1',b); assert.throws(() => m.claimApprove('p1',b),{code:'PLAN_NOT_PROPOSED'});
  assert.throws(() => m.rollback('p1','forged'),{code:'INVALID_CLAIM'});
  m.rollback('p1',claim.claimId,'busy'); const retry=m.claimApprove('p1',b); m.complete('p1',retry.claimId);
  assert.throws(() => m.claimApprove('p1',b),{code:'PLAN_NOT_PROPOSED'});
});
test('accepted Plan failure spends authority even without a tool-end event', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2-started-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = binding(dir); const manager = new PlanStateManager();
  manager.propose({ ...b, planId: 'partial', markdown: 'write once' });
  const claim = manager.claimApprove('partial', b);
  manager.markStarted('partial', claim.claimId);
  assert.throws(() => manager.rollback('partial', claim.claimId), { code: 'PLAN_EXECUTION_ALREADY_STARTED' });
  assert.equal(manager.fail('partial', claim.claimId, 'partial failure').status, 'expired');
  assert.equal(manager.getPending('s', b), null);
  assert.throws(() => manager.claimApprove('partial', b), { code: 'PLAN_NOT_PROPOSED' });
});
test('plan superseding rejection expiry and reload never restore authority', (t) => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'e2-plan-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const b=binding(dir);let now=10;const m=new PlanStateManager({now:()=>now,ttlMs:50});
  m.create({...b,planId:'a'});m.create({...b,planId:'b'});assert.throws(()=>m.claimApprove('a',b),{code:'PLAN_NOT_PROPOSED'});m.reject('b',b);m.create({...b,planId:'c'});now=61;assert.equal(m.getPending('s',b),null);
  m.create({...b,planId:'d'});m.expireSender(42);assert.equal(m.getPending('s',b),null);
  const restored=helper.restore({role:'assistant',parts:[{type:'plan',planId:'d',status:'proposed'}]},schema);assert.equal(restored.parts[0].status,'expired');assert.equal(new PlanStateManager().getPending('s',b),null);
});
test('all projections and exports redact registered strings while budget counts survive', () => {
  const secret='E2-DYNAMIC-CREDENTIAL-TEST';defaultSecretManager.registerSecret(secret,'test');
  const m={role:'assistant',content:secret,parts:[{type:'text',text:secret},{type:'attachment_ref',name:'a',budget:{estimatedTokens:42,maxBytes:100}}],trajectory:[{kind:'tool',tool:'x',argsSummary:secret,detail:{output:secret}}]};
  for(const value of [schema.projectToStorageJson(m),schema.projectToUiModel(m),schema.projectToModelMessages([m])])assert.ok(!JSON.stringify(value).includes(secret));
  assert.equal(schema.projectToStorageJson(m).parts[1].budget.estimatedTokens,42);
  const exp=require('../src/ai/session-export');assert.ok(!exp.exportSessionMarkdown({messages:[m]}).includes(secret));assert.ok(!exp.exportSessionJson({messages:[m]}).includes(secret));
  assert.ok(!createTaskEventEnvelope({taskId:'t',data:{output:secret}}).data.output.includes(secret));
});
test('trajectory correlates same-tool concurrent calls, approvals, verification, subagents and bounds persisted data', () => {
  const run={trajectory:[]};const emit=(ev,now)=>helper.collect(run,ev,schema,now);
  emit({type:'tool-start',callId:'a',tool:'read',args:{token:'secret'}},100);emit({type:'tool-start',callId:'b',tool:'read'},110);emit({type:'tool-end',callId:'b',tool:'read',ok:true},140);emit({type:'tool-end',callId:'a',tool:'read',ok:false},150);
  assert.deepEqual(run.trajectory.map(x=>[x.callId,x.durationMs,x.status]),[['a',50,'error'],['b',30,'success']]);
  emit({type:'approval-needed',approvalId:'ap',tool:'write',description:'write file'},160);emit({type:'approval-resolved',approvalId:'ap',decision:'allow_once'},170);
  assert.equal(run.trajectory[2].decision,'allow_once');assert.equal(run.trajectory[2].description,'write file');
  emit({type:'verify-result',ok:false,checks:['test'],failureCount:1},180);emit({type:'subagent-start',subagentId:'sub',goal:'work'},200);emit({type:'subagent-end',subagentId:'sub',ok:true},250);assert.equal(run.trajectory.at(-1).durationMs,50);
  for(let i=0;i<80;i++)emit({type:'tool-end',callId:String(i),tool:'x',output:'a'.repeat(10000)},300+i);
  assert.equal(run.trajectory.length,50);assert.ok(run.trajectory.at(-1).detail.output.length<2100);
});
test('TaskHandle enforces actual lifecycle cancellation and terminal event boundaries',()=>{
  const events=[];const h=new TaskHandle({taskId:'t',onStatusChange:e=>events.push(e)});h.start();assert.equal(h.state,'running');assert.equal(h.cancel('timeout'),true);assert.equal(h.signal.aborted,true);assert.equal(h.cancelReason,'timeout');assert.equal(h.cancel('user_request'),false);assert.throws(()=>h.complete());
  const done=new TaskHandle();done.start();done.complete();assert.equal(done.state,'completed');assert.throws(()=>done.start());assert.throws(()=>createTaskEventEnvelope({}));assert.ok(events.length>=3);
});
test('renderer approval creates run before IPC events and retains retryable plan',async()=>{
  const src=fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8');const helper=src.slice(src.indexOf('function waitForChatRunEvents('),src.indexOf('function createAssistantRunPlaceholder('));const code=helper+src.slice(src.indexOf('async function approvePlanFromCard('),src.indexOf('\nfunction renderVerifyStrip'));
  const session={id:'s',messages:[{role:'assistant',parts:[{type:'plan',planId:'p',status:'proposed'}]}]};const trace=[];
  const ctx={setTimeout,clearTimeout,console,sessions:[session],activeSessionId:'s',sending:false,chatRun:null,window:{codex:{messageSchema:schema,approvePlan:async()=>{assert.ok(ctx.chatRun);trace.push('ipc');ctx.chatRun.trajectory.push({kind:'tool'});return {ok:false,isRetryable:true,error:'busy'};}}},sessionProject:()=>null,setSending:x=>ctx.sending=x,createAssistantRunPlaceholder:()=>{trace.push('run');ctx.chatRun={sessionId:'s',trajectory:[],el:{remove(){}},finalized:false};},finalizeChatRun:()=>{ctx.chatRun.finalized=true;},setPersistedPlanStatus:()=>{},toast:()=>{},saveState:()=>{},renderMessages:()=>{},renderLeftDynamic:()=>{},updateAgentModeToggle:()=>{},worktreeBindings:new Map(),Date};vm.createContext(ctx);vm.runInContext(code,ctx);await ctx.approvePlanFromCard(null,{planId:'p',sessionId:'s'});assert.deepEqual(trace,['run','ipc']);assert.equal(session.messages[0].parts[0].status,'proposed');assert.equal(ctx.sending,false);
});
