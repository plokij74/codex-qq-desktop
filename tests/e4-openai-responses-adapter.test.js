'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const{invokeModelTurn}=require('../src/ai/model-router');const{createModelChatFunction}=require('../src/ai/llm-client');
const{makeBinding,mockFetch,jsonResponse,streamResponse,sse,tools,messages,credential}=require('./fixtures/e4-models/synthetic');
const completed=(output,usage={input_tokens:12,output_tokens:4,input_tokens_details:{cached_tokens:3}})=>({id:'resp_synthetic',status:'completed',output,usage});
const textItem={id:'m1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'synthetic answer',annotations:[]}]};
test('Responses instructions/store false, complete output continuity and call_id tool result',async()=>{
 const binding=makeBinding('openai-responses');const output=[{...textItem,content:[{type:'output_text',text:'checking',annotations:[{type:'synthetic_note',value:'retained-run-only'}]}]},{type:'function_call',id:'item_1',call_id:'call_1',name:'synthetic_echo',arguments:'{"text":"ok"}',status:'completed'}];
 const fetchFn=mockFetch(jsonResponse(completed(output)),jsonResponse(completed([textItem])));const first=await invokeModelTurn({binding,messages,tools,fetchFn,resolveCredential:credential});assert.equal(first.toolCalls[0].id,'call_1');assert.deepEqual(JSON.parse(JSON.stringify(first.providerState)),{});
 await invokeModelTurn({binding,messages:[...messages,{role:'assistant',content:first.content,toolCalls:first.toolCalls},{role:'tool',toolCallId:'call_1',content:'ok'}],tools,providerState:first.providerState,fetchFn,resolveCredential:credential});
 assert.equal(fetchFn.calls[0].url,'https://synthetic.invalid/gateway/v1/responses');assert.equal(fetchFn.calls[0].body.instructions,'Synthetic host prefix.\n\nSecond synthetic prefix.');assert.equal(fetchFn.calls[0].body.store,false);assert.equal(fetchFn.calls[0].body.max_output_tokens,256);assert.equal('previous_response_id'in fetchFn.calls[1].body,false);assert.deepEqual(fetchFn.calls[1].body.input.slice(1,3),output);assert.deepEqual(fetchFn.calls[1].body.input.at(-1),{type:'function_call_output',call_id:'call_1',output:'ok'});
});
test('Responses state rejects cross-binding/mutated history and wrapper never exposes state',async()=>{
 const binding=makeBinding('openai-responses');const fetchFn=mockFetch(jsonResponse(completed([textItem])),jsonResponse(completed([textItem])));const first=await invokeModelTurn({binding,messages,fetchFn,resolveCredential:credential});
 await assert.rejects(invokeModelTurn({binding:makeBinding('openai-responses'),messages,providerState:first.providerState,fetchFn,resolveCredential:credential}),{code:'MODEL_STATE_INVALID'});
 const fn=createModelChatFunction({binding,fetchFn,resolveCredential:credential});const value=await fn({messages});assert.equal('providerState'in value,false);
});
test('Responses streaming final snapshot does not duplicate text; incomplete is length',async()=>{
 const binding=makeBinding('openai-responses',{compatibility:{streamMode:'on'}});const events=[];const frames=sse([{type:'response.output_item.added',output_index:0,item:{id:'m1',type:'message',role:'assistant',content:[]}},{type:'response.output_text.delta',item_id:'m1',output_index:0,content_index:0,delta:'synthetic answer'},{type:'response.output_item.done',output_index:0,item:textItem},{type:'response.completed',response:completed([textItem])}]);
 const turn=await invokeModelTurn({binding,messages,fetchFn:mockFetch(streamResponse(frames,3)),resolveCredential:credential,onEvent:e=>events.push(e)});assert.equal(turn.content,'synthetic answer');assert.equal(events.filter(e=>e.type==='text-delta').map(e=>e.delta).join(''),'synthetic answer');assert.equal(turn.usage.cachedInputTokens,3);
 const short=await invokeModelTurn({binding:makeBinding('openai-responses'),messages,fetchFn:mockFetch(jsonResponse({...completed([textItem]),status:'incomplete',incomplete_details:{reason:'max_output_tokens'}})),resolveCredential:credential});assert.equal(short.finishReason,'length');
});
test('Responses streaming native calls preserve item continuity through the legacy wrapper',async()=>{
 const call={type:'function_call',id:'item_stream',call_id:'call_stream',name:'synthetic_echo',arguments:'{"text":"streamed"}',status:'completed'};
 const frames=sse([{type:'response.output_item.added',output_index:0,item:{...call,arguments:'',status:'in_progress'}},{type:'response.function_call_arguments.delta',output_index:0,item_id:call.id,delta:call.arguments},{type:'response.output_item.done',output_index:0,item:call},{type:'response.completed',response:completed([call])}]);
 const nextFrames=sse([{type:'response.completed',response:completed([textItem])}]);
 const fetchFn=mockFetch(streamResponse(frames,2),streamResponse(nextFrames)); const usage=[];
 const fn=createModelChatFunction({binding:makeBinding('openai-responses',{compatibility:{streamMode:'on'}}),resolveCredential:credential,fetchFn,onUsage:e=>usage.push(e)});
 const first=await fn({messages,tools:tools.map(t=>({type:'function',function:t}))}); assert.equal(first.tool_calls[0].id,'call_stream'); assert.equal('providerState' in first,false);
 await fn({messages:[...messages,{role:'assistant',content:first.content,tool_calls:first.tool_calls},{role:'tool',tool_call_id:'call_stream',content:'streamed'}],tools:tools.map(t=>({type:'function',function:t}))});
 assert.deepEqual(fetchFn.calls[1].body.input.slice(1,2),[call]); assert.equal(fetchFn.calls[1].body.input.at(-1).call_id,'call_stream'); assert.equal(usage.length,2); assert.notEqual(usage[0].attemptId,usage[1].attemptId);
});
test('Responses wrapper treats independent consumer history as a new explicit request',async()=>{
 const annotated={...textItem,content:[{type:'output_text',text:'synthetic answer',annotations:[{type:'synthetic_note',value:'first-history-only'}]}]};
 const fetchFn=mockFetch(jsonResponse(completed([annotated])),jsonResponse(completed([textItem]))); const fn=createModelChatFunction({binding:makeBinding('openai-responses'),resolveCredential:credential,fetchFn});
 await fn({messages}); await fn({messages:[{role:'user',content:'Independent synthetic consumer.'}]});
 assert.deepEqual(fetchFn.calls[1].body.input,[{role:'user',content:'Independent synthetic consumer.'}]);
});
test('Responses unsupported reasoning/hosted output and unterminated stream fail safely',async()=>{
 for(const output of [[{type:'reasoning',summary:[]}],[{type:'web_search_call',id:'hosted'}]])await assert.rejects(invokeModelTurn({binding:makeBinding('openai-responses'),messages,fetchFn:mockFetch(jsonResponse(completed(output))),resolveCredential:credential}),{code:'MODEL_FEATURE_UNSUPPORTED'});
 await assert.rejects(invokeModelTurn({binding:makeBinding('openai-responses',{compatibility:{streamMode:'on'}}),messages,fetchFn:mockFetch(streamResponse(sse([{type:'response.output_text.delta',output_index:0,item_id:'m1',delta:'partial'}]))),resolveCredential:credential}),{code:'MODEL_PROTOCOL_ERROR'});
});
