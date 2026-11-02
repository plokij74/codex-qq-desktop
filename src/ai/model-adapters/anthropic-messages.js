'use strict';
const { requireValue, record, parseJson, bytes, emit } = require('./common');
const { postJson, readJson, readSse } = require('./transport');
function finish(reason) {
  const reasons = { end_turn: 'stop', stop_sequence: 'stop', tool_use: 'tool_calls', max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'filtered' };
  return typeof reason === 'string' && Object.hasOwn(reasons, reason) ? reasons[reason] : 'unknown';
}
function encodeMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      const prior = result.at(-1);
      if (prior?.role === 'user' && prior.content.every((part) => part.type === 'tool_result')) prior.content.push(block); else result.push({ role: 'user', content: [block] });
      continue;
    }
    const content = [];
    if (m.content || !m.toolCalls?.length) content.push({ type: 'text', text: m.content });
    for (const call of m.toolCalls || []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: parseJson(call.argumentsJson, 'MODEL_INPUT_INVALID') });
    result.push({ role: m.role, content });
  }
  return result;
}
function normalize(raw) {
  requireValue(record(raw) && !raw.error && Array.isArray(raw.content) && (raw.type === undefined || raw.type === 'message') && (raw.role === undefined || raw.role === 'assistant')); let content = ''; const toolCalls = [];
  for (const block of raw.content) {
    requireValue(record(block));
    if (block.type === 'text') { requireValue(typeof block.text === 'string'); content += block.text; }
    else if (block.type === 'tool_use') { requireValue(record(block.input)); toolCalls.push({ id: block.id, name: block.name, argumentsJson: JSON.stringify(block.input) }); }
    else requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'This Anthropic content feature is unsupported.');
  }
  requireValue(typeof raw.stop_reason === 'string');
  const finishReason = finish(raw.stop_reason); requireValue(finishReason !== 'unknown', 'MODEL_FEATURE_UNSUPPORTED', 'This Anthropic stop reason requires an unsupported feature.');
  requireValue(finishReason !== 'tool_calls' || toolCalls.length > 0);
  return { content, toolCalls, finishReason, rawUsage: raw.usage };
}
function requireOutput(turn, context) {
  if (turn.content.length || turn.toolCalls.length || ['filtered', 'length'].includes(turn.finishReason)) return;
  context.validatedUsage = turn.rawUsage;
  requireValue(false, 'MODEL_EMPTY_RESPONSE', 'The model returned no text or tool calls.');
}
async function invoke(options) {
  const { binding, messages, tools, request, headers, url, context, fetchFn, onAttempt } = options;
  const body = { model: binding.model, messages: encodeMessages(messages), max_tokens: request.maxOutputTokens, stream: request.stream };
  const system = messages.filter((m) => m.role === 'system').map((m) => ({ type: 'text', text: m.content })); if (system.length) body.system = system;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.stop !== undefined) body.stop_sequences = request.stop;
  if (tools.length) body.tools = tools.map((t) => ({ name: t.name, ...(t.description === undefined ? {} : { description: t.description }), input_schema: t.parameters }));
  const response = await postJson({ url, body, headers: { ...headers, 'anthropic-version': '2023-06-01' }, fetchFn, context, onAttempt });
  if (!request.stream) { const result = normalize(await readJson(response, context)); requireOutput(result, context); emit(context.onEvent, result.content); return result; }
  let started = false; let stopped = false; let stopReason; let usage = {}; const blocks = new Map();
  for await (const frame of readSse(response, context)) {
    const event = parseJson(frame.data); requireValue(record(event) && typeof event.type === 'string' && (!frame.event || frame.event === event.type));
    if (event.type === 'ping') continue;
    if (event.type === 'error') requireValue(false, 'MODEL_PROTOCOL_ERROR', 'The Anthropic stream failed before completion.');
    if (event.type === 'message_start') { requireValue(!started && record(event.message) && Array.isArray(event.message.content) && event.message.content.length === 0 && (event.message.type === undefined || event.message.type === 'message') && (event.message.role === undefined || event.message.role === 'assistant') && (event.message.stop_reason === undefined || event.message.stop_reason === null)); started = true; usage = { ...event.message.usage }; continue; }
    requireValue(started, 'MODEL_PROTOCOL_ERROR', 'The Anthropic stream has no message start.');
    requireValue(stopReason === undefined || ['message_delta', 'message_stop'].includes(event.type), 'MODEL_PROTOCOL_ERROR', 'The Anthropic stream added content after its terminal stop reason.');
    if (event.type === 'content_block_start') {
      requireValue(Number.isSafeInteger(event.index) && event.index === blocks.size && event.index < 1024 && record(event.content_block));
      // Anthropic blocks are sequential. Opening a later block while one is
      // still live would make flattened text events disagree with final order.
      requireValue(event.index === 0 || blocks.get(event.index - 1)?.stopped, 'MODEL_PROTOCOL_ERROR', 'The Anthropic stream opened a block before the previous block stopped.');
      const raw = event.content_block;
      requireValue(['text', 'tool_use'].includes(raw.type), 'MODEL_FEATURE_UNSUPPORTED', 'This Anthropic content block is unsupported.');
      if (raw.type === 'text') requireValue(typeof raw.text === 'string'); else { requireValue(record(raw.input)); requireValue(bytes(JSON.stringify(raw.input)) <= context.limits.maxArgumentsBytes, 'MODEL_LIMIT_EXCEEDED', 'Tool arguments exceed their byte limit.'); }
      blocks.set(event.index, { raw: structuredClone(raw), stopped: false, json: '', jsonSeen: false }); if (raw.type === 'text') emit(context.onEvent, raw.text);
    } else if (event.type === 'content_block_delta') {
      const entry = blocks.get(event.index); requireValue(entry && !entry.stopped && record(event.delta));
      if (event.delta.type === 'text_delta') { requireValue(entry.raw.type === 'text' && typeof event.delta.text === 'string'); entry.raw.text += event.delta.text; emit(context.onEvent, event.delta.text); }
      else if (event.delta.type === 'input_json_delta') { requireValue(entry.raw.type === 'tool_use' && typeof event.delta.partial_json === 'string' && Object.keys(entry.raw.input).length === 0, 'MODEL_PROTOCOL_ERROR', 'Anthropic tool fragments cannot overwrite initial input.'); entry.jsonSeen = true; entry.json += event.delta.partial_json; requireValue(bytes(entry.json) <= context.limits.maxArgumentsBytes, 'MODEL_LIMIT_EXCEEDED', 'Tool arguments exceed their byte limit.'); }
      else requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'This Anthropic content delta is unsupported.');
    } else if (event.type === 'content_block_stop') {
      const entry = blocks.get(event.index); requireValue(entry && !entry.stopped); entry.stopped = true;
      if (entry.raw.type === 'tool_use' && entry.jsonSeen) entry.raw.input = parseJson(entry.json, 'MODEL_TOOL_INVALID');
    } else if (event.type === 'message_delta') {
      requireValue(record(event.delta));
      if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
        requireValue([...blocks.values()].every((entry) => entry.stopped) && (stopReason === undefined || stopReason === event.delta.stop_reason), 'MODEL_PROTOCOL_ERROR', 'The Anthropic terminal stop reason is premature or changed.');
        stopReason = event.delta.stop_reason;
      }
      if (event.usage) usage = { ...usage, ...event.usage };
    }
    else if (event.type === 'message_stop') { requireValue([...blocks.values()].every((entry) => entry.stopped) && finish(stopReason) !== 'unknown', 'MODEL_PROTOCOL_ERROR', 'The Anthropic stream stopped with unfinished content.'); stopped = true; break; }
    else requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'This Anthropic stream event is unsupported.');
  }
  context.check(); requireValue(started && stopped, 'MODEL_PROTOCOL_ERROR', 'The Anthropic stream ended without message_stop.');
  const result = normalize({ content: [...blocks.values()].map((entry) => entry.raw), stop_reason: stopReason, usage });
  requireOutput(result, context); return result;
}
module.exports = { invoke, encodeMessages };
