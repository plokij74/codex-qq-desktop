'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const{invokeModelTurn}=require('../src/ai/model-router');const{createModelChatFunction}=require('../src/ai/llm-client');
const{makeBinding,mockFetch,jsonResponse,streamResponse,sse,messages,credential,chat}=require('./fixtures/e4-models/synthetic');
test('HTTP errors are safe and never retry; usage once per physical failed attempt',async()=>{
 for(const [status,code]of [[400,'MODEL_BAD_REQUEST'],[401,'MODEL_AUTH_FAILED'],[403,'MODEL_FORBIDDEN'],[404,'MODEL_NOT_FOUND'],[429,'MODEL_RATE_LIMITED'],[500,'MODEL_UPSTREAM_ERROR']]){const usage=[];const fetchFn=mockFetch(jsonResponse({error:{message:'synthetic-not-a-real-key raw private body stream_options unsupported tools'}},status,{'retry-after':'3','x-request-id':'synthetic_request_id'}));const fn=createModelChatFunction({binding:makeBinding(),fetchFn,resolveCredential:credential,onUsage:e=>usage.push(e)});await assert.rejects(fn({messages}),e=>{assert.equal(e.code,code);assert.equal(e.message.includes('synthetic-not-a-real-key'),false);assert.equal(JSON.stringify(e).includes('raw private body'),false);return true;});assert.equal(fetchFn.calls.length,1);assert.equal(usage.length,1);assert.equal(usage[0].usage.source,'unavailable');assert.equal(usage[0].status,'failed');}
});
test('completed text can be estimated, missing cache is unknown not zero',async()=>{
 const binding=makeBinding();const missing=await invokeModelTurn({binding,messages,resolveCredential:credential,fetchFn:mockFetch(jsonResponse(chat('12345678',{usage:undefined})))});assert.equal(missing.usage.source,'estimated');assert.equal(missing.usage.cachedInputTokens,null);
 const actual=await invokeModelTurn({binding,messages,resolveCredential:credential,fetchFn:mockFetch(jsonResponse(chat('ok',{usage:{prompt_tokens:10,completion_tokens:2}})))});assert.equal(actual.usage.source,'actual');assert.equal(actual.usage.cachedInputTokens,null);
});
test('abort interrupts hanging credential/fetch/read and timeout spans credential resolution',async()=>{
 const binding=makeBinding();const controller=new AbortController();const promise=invokeModelTurn({binding,messages,signal:controller.signal,resolveCredential:()=>new Promise(()=>{}),fetchFn:mockFetch()});controller.abort();await assert.rejects(promise,{code:'ABORTED'});
 await assert.rejects(invokeModelTurn({binding,messages,request:{timeoutMs:5},resolveCredential:()=>new Promise(()=>{}),fetchFn:mockFetch()}),{code:'MODEL_TIMEOUT'});
 const stopped=new AbortController();const fetchFn=mockFetch(()=>new Promise(()=>{}));const usage=[];const fn=createModelChatFunction({binding,fetchFn,resolveCredential:credential,signal:stopped.signal,onUsage:e=>usage.push(e)});const pending=fn({messages});setImmediate(()=>stopped.abort());await assert.rejects(pending,{code:'ABORTED'});assert.equal(fetchFn.calls.length,1);assert.equal(usage.length,1);assert.equal(usage[0].status,'cancelled');
});
test('request/response/frame/tool argument budgets fail without truncating or retrying',async()=>{
 const binding=makeBinding();const fetchFn=mockFetch(jsonResponse(chat('response exceeding tiny limit')));await assert.rejects(invokeModelTurn({binding,messages,request:{maxRequestBytes:16},fetchFn,resolveCredential:credential}),{code:'MODEL_LIMIT_EXCEEDED'});assert.equal(fetchFn.calls.length,0);
 await assert.rejects(invokeModelTurn({binding,messages,request:{maxResponseBytes:16},fetchFn,resolveCredential:credential}),{code:'MODEL_LIMIT_EXCEEDED'});assert.equal(fetchFn.calls.length,1);
 await assert.rejects(invokeModelTurn({binding:makeBinding(undefined,{compatibility:{streamMode:'on'}}),messages,request:{maxFrameBytes:20},fetchFn:mockFetch(streamResponse(sse([{choices:[{delta:{content:'x'.repeat(100)}}]},'[DONE]']))),resolveCredential:credential}),{code:'MODEL_LIMIT_EXCEEDED'});
});
test('body-read cancellation closes its reader exactly once and records one cancelled attempt',async()=>{
 const counters={cancel:0,release:0}; const controller=new AbortController(); const usage=[];
 const response={status:200,headers:new Headers(),body:{getReader(){return{read:()=>new Promise(()=>{}),cancel(){counters.cancel++;return Promise.resolve();},releaseLock(){counters.release++;}};}}};
 const fetchFn=mockFetch(response); const fn=createModelChatFunction({binding:makeBinding(),resolveCredential:credential,fetchFn,signal:controller.signal,onUsage:e=>usage.push(e)});
 const pending=fn({messages}); setImmediate(()=>controller.abort()); await assert.rejects(pending,{code:'ABORTED'});
 assert.deepEqual(counters,{cancel:1,release:1}); assert.equal(fetchFn.calls.length,1); assert.equal(usage.length,1); assert.equal(usage[0].status,'cancelled');
});
test('late fetch completion after cancellation closes its body without a second usage event',async()=>{
 let finish;let cancellations=0;const eventual=new Promise(resolve=>{finish=resolve;});const controller=new AbortController();const usage=[];const fetchFn=mockFetch(()=>eventual);
 const fn=createModelChatFunction({binding:makeBinding(),resolveCredential:credential,fetchFn,signal:controller.signal,onUsage:e=>usage.push(e)});
 const pending=fn({messages});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(pending,{code:'ABORTED'});
 finish({status:200,headers:new Headers(),body:{cancel(){cancellations++;return Promise.resolve();}}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(cancellations,1);assert.equal(fetchFn.calls.length,1);assert.equal(usage.length,1);assert.equal(usage[0].status,'cancelled');
});
test('preflight cancellation and missing credentials never create a usage attempt',async()=>{
 const controller=new AbortController(); controller.abort(); const usage=[]; const fetchFn=mockFetch();
 const cancelled=createModelChatFunction({binding:makeBinding(),resolveCredential:credential,fetchFn,signal:controller.signal,onUsage:e=>usage.push(e)});
 await assert.rejects(cancelled({messages}),{code:'ABORTED'});
 const unconfigured=createModelChatFunction({binding:makeBinding(),resolveCredential:async()=>'',fetchFn,onUsage:e=>usage.push(e)});
 await assert.rejects(unconfigured({messages}),{code:'MODEL_AUTH_REQUIRED'}); assert.equal(fetchFn.calls.length,0); assert.deepEqual(usage,[]);
});
test('invalid UTF8 is a protocol failure rather than a connection retry',async()=>{
 await assert.rejects(invokeModelTurn({binding:makeBinding(),messages,resolveCredential:credential,fetchFn:mockFetch(new Response(new Uint8Array([255])))}),{code:'MODEL_PROTOCOL_ERROR'});
});
test('redirect, unexpected response URL, empty and malformed responses stay failed',async()=>{
 const binding=makeBinding();for(const res of [new Response('',{status:302,headers:{location:'https://other.invalid'}}),new Response(''),new Response('not-json')])await assert.rejects(invokeModelTurn({binding,messages,fetchFn:mockFetch(res),resolveCredential:credential}));
 const res=jsonResponse(chat());Object.defineProperty(res,'url',{value:'https://other.invalid/private?token=private'});await assert.rejects(invokeModelTurn({binding,messages,fetchFn:mockFetch(res),resolveCredential:credential}),{code:'MODEL_REDIRECT_REFUSED'});
});
