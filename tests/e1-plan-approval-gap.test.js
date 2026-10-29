'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const schema = require('../src/ai/message-schema');
const helper = require('../src/renderer/e2-messages');
const appSource = fs.readFileSync(path.join(__dirname,'../src/renderer/app.js'),'utf8');
function extract(start,end) { const a=appSource.indexOf(start),b=appSource.indexOf(end,a);assert.ok(a>=0&&b>a);return appSource.slice(a,b); }
test('G04 finalized plan approves with no live run, prepares collector before invoking main',async()=>{
  const session={id:'s',messages:[schema.createMessageV2({role:'assistant',parts:[{type:'plan',planId:'p',markdown:'steps',status:'proposed'}]})]};const trace=[];
  const ctx={sessions:[session],activeSessionId:'s',sending:false,chatRun:null,sessionProject:()=>null,window:{codex:{messageSchema:schema,approvePlan:async()=>{assert.ok(ctx.chatRun);trace.push('invoke');ctx.chatRun.doneEvent=true;ctx.chatRun.trajectory.push({kind:'tool',tool:'read'});return{ok:true,result:{content:'done'}};}}},setSending:x=>ctx.sending=x,createAssistantRunPlaceholder:()=>{trace.push('create');ctx.chatRun={sessionId:'s',trajectory:[],textBuffer:'',finalized:false};},finalizeChatRun:(result)=>{trace.push('finalize');assert.equal(ctx.chatRun.trajectory.length,1);assert.equal(result.content,'done');ctx.chatRun=null;},toast:()=>{},saveState:()=>{},renderMessages:()=>{},renderLeftDynamic:()=>{},updateAgentModeToggle:()=>{},worktreeBindings:new Map(),Date};
  Object.assign(ctx,{setTimeout,clearTimeout});
  vm.createContext(ctx);vm.runInContext(extract('function waitForChatRunEvents(','function createAssistantRunPlaceholder('),ctx);vm.runInContext(extract('async function approvePlanFromCard(','\nfunction renderVerifyStrip'),ctx);await ctx.approvePlanFromCard(null,{sessionId:'s',planId:'p'});
  assert.deepEqual(trace,['create','invoke','finalize']);assert.equal(session.messages[0].parts[0].status,'approved');assert.equal(ctx.sending,false);
});
test('G05 real saveState uses bounded shared projection and reload expires historical authorization',()=>{
  const output=new Map();const msg={role:'assistant',content:'hello',parts:[{type:'plan',planId:'p',status:'proposed'}],trajectory:Array.from({length:80},()=>({kind:'tool',tool:'read',detail:{token:'secret',output:'x'.repeat(5000)}}))};
  const ctx={sessions:[{id:'s',messages:[msg]}],projects:[],activeSessionId:'s',pluginState:{},STORAGE_KEY:'state',localStorage:{setItem:(k,v)=>output.set(k,v)},ensureSessionCandidateState:()=>{},ensureSessionWorktreeState:()=>{},window:{codex:{messageSchema:schema},E2Messages:helper}};
  vm.createContext(ctx);vm.runInContext(extract('function saveState()','\nfunction activeSession()'),ctx);ctx.saveState();const stored=JSON.parse(output.get('state')).sessions[0].messages[0];assert.equal(stored.trajectory.length,50);assert.equal(stored.trajectory[0].detail.token,'[REDACTED]');assert.ok(stored.trajectory[0].detail.output.length<2100);
  vm.runInContext(extract('function normalizeSessionMessageClient(', '\nfunction loadState()'),ctx);const restored=ctx.normalizeSessionMessageClient(stored);assert.equal(restored.parts[0].status,'expired');assert.equal(restored.trajectory.length,50);
});
