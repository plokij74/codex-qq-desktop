'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {invokeModelTurn}=require('../src/ai/model-router');
const {makeBinding,mockFetch,jsonResponse,streamResponse,sse,tools,messages,credential,chat}=require('./fixtures/e4-models/synthetic');
test('Chat JSON maps host prefix, auth, explicit token field and tool roundtrip',async()=>{
 const binding=makeBinding(undefined,{request:{chatTokenLimitField:'max_completion_tokens'}});const fetchFn=mockFetch(jsonResponse(chat(null,{choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call_echo',type:'function',function:{name:'synthetic_echo',arguments:'{"text":"ok"}'}}]},finish_reason:'tool_calls'}]})),jsonResponse(chat()));
 const first=await invokeModelTurn({binding,messages,tools,fetchFn,resolveCredential:credential});assert.equal(first.toolCalls[0].id,'call_echo');assert.equal(first.finishReason,'tool_calls');
 await invokeModelTurn({binding,messages:[...messages,{role:'assistant',content:first.content,toolCalls:first.toolCalls},{role:'tool',toolCallId:'call_echo',content:'ok'}],tools,fetchFn,resolveCredential:credential});
 const firstWire=fetchFn.calls[0];assert.equal(firstWire.options.headers.Authorization,'Bearer synthetic-not-a-real-key');assert.equal(firstWire.options.redirect,'error');assert.equal(firstWire.body.max_completion_tokens,256);assert.equal('max_tokens'in firstWire.body,false);assert.equal(firstWire.body.messages[1].role,'system');assert.equal(fetchFn.calls[1].body.messages.at(-1).tool_call_id,'call_echo');
});
test('Chat SSE assembles split UTF8 text/tool arguments, usage once and requires DONE',async()=>{
 const binding=makeBinding(undefined,{compatibility:{streamMode:'on'}}); const events=[];const frames=sse([{choices:[{delta:{content:'你好',tool_calls:[{index:0,id:'c',function:{name:'synthetic_echo',arguments:'{"text":'}}]}}]},{choices:[{delta:{tool_calls:[{index:0,function:{arguments:'"ok"}'}}]},finish_reason:'tool_calls'}]},{choices:[],usage:{prompt_tokens:10,completion_tokens:4}},'[DONE]']);
 const fetchFn=mockFetch(streamResponse(frames,1));const turn=await invokeModelTurn({binding,messages,tools,fetchFn,resolveCredential:credential,onEvent:e=>events.push(e)});assert.equal(turn.content,'你好');assert.equal(turn.toolCalls[0].argumentsJson,'{"text":"ok"}');assert.equal(turn.usage.inputTokens,10);assert.equal(events.filter(e=>e.type==='text-delta').map(e=>e.delta).join(''),'你好');
 await assert.rejects(invokeModelTurn({binding,messages,tools,fetchFn:mockFetch(streamResponse(sse([{choices:[{delta:{content:'partial'},finish_reason:'stop'}]}]))),resolveCredential:credential}),{code:'MODEL_PROTOCOL_ERROR'});
});
test('Chat tool JSON/schema invalid cannot yield executable tool calls',async()=>{
 for(const argumentsJson of ['{"text":','{"text":7}','{"text":"ok","extra":true}']){const fetchFn=mockFetch(jsonResponse(chat('',{choices:[{message:{content:'',tool_calls:[{id:'c',type:'function',function:{name:'synthetic_echo',arguments:argumentsJson}}]},finish_reason:'tool_calls'}]})));await assert.rejects(invokeModelTurn({binding:makeBinding(),messages,tools,fetchFn,resolveCredential:credential}),{code:'MODEL_TOOL_INVALID'});}
});
