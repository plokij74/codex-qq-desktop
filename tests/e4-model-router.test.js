'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { invokeModelTurn } = require('../src/ai/model-router');
const { createModelChatFunction } = require('../src/ai/llm-client');
const { makeBinding, mockFetch, jsonResponse, chat, messages, tools, credential } = require('./fixtures/e4-models/synthetic');
test('pure preflight checks acceptance without credentials, events or requests', () => {
 const {preflightModelRequest}=require('../src/ai/model-router'); const binding=makeBinding(undefined,{request:{maxOutputTokens:128}});
 const prepared=preflightModelRequest({binding,messages,tools,request:{maxOutputTokens:9999}});
 assert.equal(prepared.url,'https://synthetic.invalid/gateway/v1/chat/completions'); assert.equal(prepared.request.maxOutputTokens,128); assert.equal(prepared.tools.length,1); assert.notEqual(prepared.messages,messages);
 assert.throws(()=>preflightModelRequest({binding:{...binding},messages}),{code:'MODEL_BINDING_INVALID'});
 assert.throws(()=>preflightModelRequest({binding:makeBinding(undefined,{noCredential:true}),messages}),{code:'MODEL_AUTH_REQUIRED'});
 assert.throws(()=>preflightModelRequest({binding:makeBinding(undefined,{capabilities:{text:'unsupported'}}),messages}),{code:'MODEL_CAPABILITY_REQUIRED'});
 assert.throws(()=>preflightModelRequest({binding,messages,request:{maxRequestBytes:16}}),{code:'MODEL_LIMIT_EXCEEDED'});
 assert.throws(()=>preflightModelRequest({binding:makeBinding(undefined,{contextWindow:32}),messages}),{code:'MODEL_CONTEXT_LIMIT'});
});
test('capability preflight errors carry explicit public classification without guessing messages', () => {
 const {preflightModelRequest}=require('../src/ai/model-router');
 const check=(binding,inputTools,request,state)=>assert.throws(
  ()=>preflightModelRequest({binding,messages,tools:inputTools,request}),
  error=>{assert.equal(error.code,'MODEL_CAPABILITY_REQUIRED');assert.equal(error.capabilityState,state);assert.equal(error.publicCode,state==='unsupported'?'MODEL_CAPABILITY_UNSUPPORTED':'MODEL_CAPABILITY_UNKNOWN');return true;});
 for(const state of ['unknown','unsupported']){
  check(makeBinding(undefined,{capabilities:{nativeTools:state}}),tools,{},state);
  check(makeBinding(undefined,{capabilities:{streaming:state},compatibility:{streamMode:'on'}}),[],{},state);
  check(makeBinding(undefined,{capabilities:{temperature:state},request:{temperature:0.2}}),[],{},state);
  check(makeBinding(undefined,{capabilities:{stop:state}}),[],{stop:['END']},state);
 }
 check(makeBinding(undefined,{capabilities:{text:'unsupported'}}),[],{},'unsupported');
 check(makeBinding(undefined,{capabilities:{nativeTools:'supported'},compatibility:{toolMode:'none'}}),tools,{},'unsupported');
});
test('returned usage is actual even when its optional request flag is disabled', async () => {
 const result=await invokeModelTurn({binding:makeBinding(undefined,{compatibility:{includeUsage:false}}),messages,fetchFn:mockFetch(jsonResponse(chat())),resolveCredential:credential});
 assert.equal(result.usage.source,'actual'); assert.equal(result.usage.inputTokens,9); assert.equal(result.usage.outputTokens,3);
});
test('router requires original branded binding and passes it unchanged to credential resolver', async () => {
 const binding=makeBinding(); const fetchFn=mockFetch(jsonResponse(chat())); let seen;
 const result=await invokeModelTurn({binding,messages,fetchFn,resolveCredential:async b=>{seen=b;return credential();}});
 assert.equal(seen,binding); assert.equal(result.content,'synthetic answer'); assert.equal(result.modelSource.providerId,binding.providerId); assert.ok(result.attemptId); assert.equal(fetchFn.calls.length,1);
 await assert.rejects(invokeModelTurn({binding:{...binding},messages,fetchFn,resolveCredential:credential}),{code:'MODEL_BINDING_INVALID'});
});
test('unknown text is allowed, nativeTools unknown blocks before credential/fetch', async () => {
 const binding=makeBinding(undefined,{capabilities:{text:'unknown',nativeTools:'unknown'}}); const fetchFn=mockFetch(jsonResponse(chat()));
 await invokeModelTurn({binding,messages,fetchFn,resolveCredential:credential});
 await assert.rejects(invokeModelTurn({binding,messages,tools,fetchFn,resolveCredential:()=>{throw Error('must not resolve');}}),{code:'MODEL_CAPABILITY_REQUIRED'}); assert.equal(fetchFn.calls.length,1);
});
test('non-prefix system and unsupported schema keywords fail before requests', async () => {
 const binding=makeBinding(); const fetchFn=mockFetch();
 await assert.rejects(invokeModelTurn({binding,messages:[...messages,{role:'system',content:'bad position'}],fetchFn,resolveCredential:credential}),{code:'MODEL_INPUT_INVALID'});
 await assert.rejects(invokeModelTurn({binding,messages,tools:[{name:'synthetic',parameters:{type:'object',not:{type:'null'}}}],fetchFn,resolveCredential:credential}),{code:'MODEL_SCHEMA_UNSUPPORTED'}); assert.equal(fetchFn.calls.length,0);
});
test('wrapper ignores raw endpoint/model/key and restricts preference overrides to binding', async () => {
 const binding=makeBinding(undefined,{request:{maxOutputTokens:128},compatibility:{streamMode:'off'}}); const fetchFn=mockFetch(jsonResponse(chat())); const usage=[];
 const fn=createModelChatFunction({binding,resolveCredential:credential,fetchFn,onUsage:e=>usage.push(e)});
 const result=await fn({messages,baseUrl:'https://wrong.invalid',apiKey:'wrong',model:'wrong',maxTokens:99999,temperature:0.1,stream:true});
 assert.equal(fetchFn.calls[0].url,'https://synthetic.invalid/gateway/v1/chat/completions'); assert.equal(fetchFn.calls[0].body.model,'synthetic-model'); assert.equal(fetchFn.calls[0].body.max_tokens,128); assert.equal('temperature'in fetchFn.calls[0].body,false); assert.equal(fetchFn.calls[0].body.stream,false); assert.equal(result.role,'assistant'); assert.equal('providerState'in result,false); assert.equal(usage.length,1); assert.equal(usage[0].status,'completed'); assert.equal(usage[0].usage.source,'actual');
});
test('explicit binding temperature requires support and stream auto with unknown stays off', async () => {
 const fetchFn=mockFetch(jsonResponse(chat()));
 await assert.rejects(invokeModelTurn({binding:makeBinding(undefined,{request:{temperature:0.2}}),messages,fetchFn,resolveCredential:credential}),{code:'MODEL_CAPABILITY_REQUIRED'});
 await invokeModelTurn({binding:makeBinding(undefined,{compatibility:{streamMode:'auto'},capabilities:{streaming:'unknown'}}),messages,fetchFn,resolveCredential:credential}); assert.equal(fetchFn.calls[0].body.stream,false);
});
test('text compatibility never serializes native tools and none rejects tools', async () => {
 const fetchFn=mockFetch(jsonResponse(chat()));
 await invokeModelTurn({binding:makeBinding(undefined,{compatibility:{toolMode:'text-compat'},capabilities:{nativeTools:'unknown'}}),messages,tools,fetchFn,resolveCredential:credential});
 assert.equal('tools' in fetchFn.calls[0].body,false);
 await assert.rejects(invokeModelTurn({binding:makeBinding(undefined,{compatibility:{toolMode:'none'}}),messages,tools,fetchFn,resolveCredential:credential}),{code:'MODEL_CAPABILITY_REQUIRED'});
 assert.equal(fetchFn.calls.length,1);
});
test('unfinished native tool history fails before credentials or requests', async () => {
 const fetchFn=mockFetch();
 await assert.rejects(invokeModelTurn({binding:makeBinding(),messages:[...messages,{role:'assistant',content:'',toolCalls:[{id:'unfinished',name:'synthetic_echo',argumentsJson:'{"text":"ok"}'}]}],tools,fetchFn,resolveCredential:()=>{throw Error('must not resolve');}}),{code:'MODEL_INPUT_INVALID'});
 assert.equal(fetchFn.calls.length,0);
});
test('legacy delta callbacks receive objects and unsupported preferences are omitted', async () => {
 const deltas=[]; const fn=createModelChatFunction({binding:makeBinding(),fetchFn:mockFetch(jsonResponse(chat())),resolveCredential:credential});
 await fn({messages,onDelta:d=>deltas.push(d),temperature:0.3});
 assert.deepEqual(deltas,[{text:'synthetic answer'}]);
});
test('diagnostic bypass is exact and does not bypass authentication', async () => {
 const binding=makeBinding(undefined,{kind:'model-diagnostic',capabilities:{nativeTools:'unknown'}}); const fetchFn=mockFetch(jsonResponse(chat()));
 await invokeModelTurn({binding,messages,tools,fetchFn,resolveCredential:credential,purpose:'diagnostic',diagnosticCheck:'nativeTools'}); assert.equal(fetchFn.calls.length,1);
 await assert.rejects(invokeModelTurn({binding,messages,tools,fetchFn,resolveCredential:credential,purpose:'diagnostic',diagnosticCheck:'text'}),{code:'MODEL_INPUT_INVALID'});
 await assert.rejects(invokeModelTurn({binding:makeBinding(),messages,fetchFn,resolveCredential:credential,purpose:'diagnostic',diagnosticCheck:'text'}),{code:'MODEL_INPUT_INVALID'});
 await assert.rejects(invokeModelTurn({binding,messages,fetchFn,resolveCredential:async()=>'',purpose:'diagnostic',diagnosticCheck:'text'}),{code:'MODEL_AUTH_REQUIRED'});
 await assert.rejects(invokeModelTurn({binding:makeBinding(undefined,{kind:'model-diagnostic',compatibility:{streamMode:'on'},capabilities:{text:'unsupported',streaming:'unsupported'}}),messages,tools,fetchFn,resolveCredential:credential,purpose:'diagnostic',diagnosticCheck:'nativeTools'}),{code:'MODEL_CAPABILITY_REQUIRED'});
 assert.equal(fetchFn.calls.length,1);
});
