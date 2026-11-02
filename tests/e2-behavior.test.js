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
test('renderer approval freezes correlated request before IPC, creates no preaccept run and retains retryable plan', async () => {
  const chat = require('../src/renderer/e4-chat-state');
  const source = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  const part = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a);
    return source.slice(a, b);
  };
  const state = chat.createState({ sessions: [{
    id: 's', peer: 'codex', identityType: 'ai', assistantId: 'assistant_codex',
    modelProfileId: 'model-fixed', agentMode: 'plan', projectId: 'project-fixture',
    messages: [{ role: 'assistant', content: 'Review plan', parts: [{ type: 'plan', planId: 'p', status: 'proposed', resolvedAt: null }] }],
  }] });
  const session = state.sessions[0];
  const originalMessages = JSON.parse(JSON.stringify(session.messages));
  chat.updateDraft(state, 's', { text: 'unsent next question', attachmentRefs: [] });
  const project = { id: 'project-fixture', name: 'Fixture', path: path.join(__dirname, '../offline-project-fixture') };
  const trace = [], captured = [], toasts = [];
  let syncCalls = 0;
  const context = vm.createContext({
    setTimeout, clearTimeout, console, Date, sessions: state.sessions, chatState: state,
    activeSessionId: 's', sending: false, chatRun: null,
    modelManager: { getState: () => ({ revision: 7 }) },
    pendingChatRequests: new Map(), activeForegroundTask: null,
    chatOutboxStore: { fail: () => assert.fail('Plan preflight must not consume or fail a composer outbox') },
    window: { E4ChatState: chat, codex: { messageSchema: schema, approvePlan: async (payload) => {
      trace.push('ipc');
      assert.equal(context.chatRun, null);
      assert.equal(context.sending, true);
      const entry = context.pendingChatRequests.get(payload.clientRequestId);
      assert.ok(entry);
      assert.equal(context.pendingChatRequests.size, 1);
      assert.equal(entry.accepted, false);
      assert.equal(entry.consumeDraft, false);
      assert.equal(entry.ledger.accepted, false);
      assert.equal(entry.ledger.runId, null);
      assert.equal(entry.ledger.sessionId, 's');
      assert.equal(entry.ledger.clientRequestId, payload.clientRequestId);
      assert.ok(Object.isFrozen(entry.outbox));
      assert.ok(Object.isFrozen(entry.outbox.messages));
      assert.ok(Object.isFrozen(entry.outbox.messages[0]));
      assert.equal(payload.assistantId, 'assistant_codex');
      assert.equal(payload.modelProfileId, 'model-fixed');
      assert.equal(payload.expectedRegistryRevision, 7);
      assert.equal(payload.projectBindingId, 'binding-current');
      assert.deepEqual(JSON.parse(JSON.stringify(payload.project)), project);
      assert.notEqual(payload.messages, entry.outbox.messages);
      assert.deepEqual(JSON.parse(JSON.stringify(payload.messages)), originalMessages);
      captured.push(entry);
      return { ok: false, code: 'BUSY', isRetryable: true, error: 'busy' };
    } } },
    sessionProject: () => project,
    bindWorktreeProject: async () => {
      trace.push('bind');
      assert.equal(context.chatRun, null);
      assert.equal(context.pendingChatRequests.size, 1);
      return 'binding-current';
    },
    syncModelSessionReferences: async () => {
      trace.push('refs');
      if (++syncCalls === 1) chat.updateDraft(state, 's', { text: 'edited while approval is pending', attachmentRefs: [] });
      return { ok: true };
    },
    cloneForIpc: (value) => JSON.parse(JSON.stringify(value)),
    setSending: (value) => { context.sending = value; },
    createAssistantRunPlaceholder: () => assert.fail('BUSY preflight must not create an assistant bubble'),
    finalizeChatRun: () => assert.fail('BUSY preflight must not finalize a nonexistent run'),
    toast: (message) => toasts.push(message), saveState() {}, renderMessages() {},
    renderLeftDynamic() {}, renderOutboxRecovery() {}, updateAgentModeToggle() {}, worktreeBindings: new Map(),
  });
  const code = part('function waitForChatRunEvents(', 'function createAssistantRunPlaceholder(')
    + part('async function approvePlanFromCard(', '\nfunction renderVerifyStrip')
    + part('function rejectChatEntry(', '\nfunction bindEvents()');
  vm.runInContext(code, context);
  for (let attempt = 0; attempt < 2; attempt++) {
    await context.approvePlanFromCard(null, { planId: 'p', sessionId: 's' });
    assert.equal(context.sending, false);
    assert.equal(context.pendingChatRequests.size, 0);
    assert.equal(session.messages[0].parts[0].status, 'proposed');
    assert.equal(session.messages[0].parts[0].resolvedAt, null);
  }
  assert.deepEqual(trace, ['bind', 'refs', 'ipc', 'bind', 'refs', 'ipc']);
  assert.equal(captured.length, 2);
  assert.notEqual(captured[0].outbox.clientRequestId, captured[1].outbox.clientRequestId);
  assert.ok(captured[1].outbox.draftRevision > captured[0].outbox.draftRevision);
  assert.equal(captured[0].outbox.draftText, 'unsent next question');
  assert.equal(state.draftsBySession.s.text, 'edited while approval is pending');
  assert.equal(context.chatRun, null);
  assert.equal(session.agentMode, 'plan');
  assert.deepEqual(JSON.parse(JSON.stringify(session.messages)), originalMessages);
  assert.deepEqual(toasts, ['busy', 'busy']);
});
