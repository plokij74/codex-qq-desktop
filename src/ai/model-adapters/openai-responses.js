'use strict';
const { requireValue, record, parseJson, bytes, emit } = require('./common');
const { postJson, readJson, readSse } = require('./transport');
const STATES = new WeakMap();
function invalidate(token) { if (token && typeof token === 'object') STATES.delete(token); }
function encodeMessages(messages) {
  const result = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') { result.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content }); continue; }
    if (m.content || !m.toolCalls?.length) result.push({ role: m.role, content: m.content });
    for (const call of m.toolCalls || []) result.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsJson });
  }
  return result;
}
function normalize(raw) {
  requireValue(record(raw) && !raw.error && Array.isArray(raw.output));
  requireValue(raw.status === 'completed' || raw.status === 'incomplete', 'MODEL_PROTOCOL_ERROR', 'The Responses request has no supported terminal status.');
  let content = ''; const toolCalls = []; let refused = false;
  for (const item of raw.output) {
    requireValue(record(item));
    if (item.type === 'function_call') { requireValue(item.status === undefined || item.status === 'completed' || raw.status === 'incomplete'); toolCalls.push({ id: item.call_id, name: item.name, argumentsJson: item.arguments }); }
    else if (item.type === 'message') {
      requireValue(item.role === 'assistant' && Array.isArray(item.content) && (item.status === undefined || item.status === 'completed' || raw.status === 'incomplete'));
      for (const part of item.content) {
        requireValue(record(part));
        if (part.type === 'output_text') { requireValue(typeof part.text === 'string'); content += part.text; }
        else if (part.type === 'refusal') { requireValue(typeof part.refusal === 'string'); refused = true; }
        else requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'This Responses content feature is not supported.');
      }
    } else requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'This Responses model requires unsupported reasoning or hosted output.');
  }
  const finishReason = raw.status === 'incomplete' ? (raw.incomplete_details?.reason === 'content_filter' ? 'filtered' : 'length') : refused ? 'filtered' : toolCalls.length ? 'tool_calls' : 'stop';
  return { content, toolCalls, finishReason, rawUsage: raw.usage };
}
function requireOutput(turn, context) {
  if (turn.content.length || turn.toolCalls.length || ['length', 'filtered'].includes(turn.finishReason)) return;
  context.validatedUsage = turn.rawUsage;
  requireValue(false, 'MODEL_EMPTY_RESPONSE', 'The model returned no text or tool calls.');
}
function prepareInput(binding, messages, token) {
  if (token === undefined || token === null) return encodeMessages(messages);
  const state = record(token) && STATES.get(token);
  requireValue(state && state.binding === binding, 'MODEL_STATE_INVALID', 'Responses continuation does not belong to this run binding.');
  const expected = [...state.messages, { role: 'assistant', content: state.turn.content, ...(state.turn.toolCalls.length ? { toolCalls: state.turn.toolCalls } : {}) }];
  requireValue(messages.length > expected.length && JSON.stringify(messages.slice(0, expected.length)) === JSON.stringify(expected), 'MODEL_STATE_INVALID', 'Responses continuation history no longer matches the accepted turn.');
  STATES.delete(token);
  return [...structuredClone(state.input), ...structuredClone(state.output), ...encodeMessages(messages.slice(expected.length))];
}
function sameIdentity(initial, item) {
  requireValue(record(item) && item.type === initial.type && (initial.id === undefined || item.id === initial.id), 'MODEL_PROTOCOL_ERROR', 'Responses output item identity changed during the stream.');
  if (initial.type === 'function_call') requireValue(item.call_id === initial.call_id && item.name === initial.name, 'MODEL_PROTOCOL_ERROR', 'Responses function call identity changed during the stream.');
  else requireValue(item.role === 'assistant' && Array.isArray(item.content), 'MODEL_PROTOCOL_ERROR', 'Responses message identity changed during the stream.');
}
function verifyParts(entry, item) {
  for (const [index, part] of entry.parts) {
    const actual = item.content[index];
    requireValue(record(actual) && actual.type === part.type && (!part.seen || actual[part.type === 'refusal' ? 'refusal' : 'text'] === part.text), 'MODEL_PROTOCOL_ERROR', 'Responses completed content did not match its streamed part.');
  }
}
async function readStream(response, context) {
  let raw; let terminal = false; let emitted = false; let nextOutputIndex = 0; const items = new Map();
  // Flat TEXT_DELTA events must have the same ordering as normalized content.
  // Later items/parts stay in the already response-bounded state until all
  // preceding text is known; the current first part still streams immediately.
  const flushText = () => {
    while (items.has(nextOutputIndex)) {
      const entry = items.get(nextOutputIndex);
      if (entry.initial.type === 'function_call') { nextOutputIndex += 1; continue; }
      for (;;) {
        const part = entry.parts.get(entry.emitIndex);
        if (!part) break;
        const offset = part.emittedLength ?? 0;
        if (part.type === 'output_text' && part.text.length > offset) {
          const delta = part.text.slice(offset); part.emittedLength = part.text.length;
          emitted = true; emit(context.onEvent, delta);
        }
        if (!part.textDone && !part.done && !entry.done) return;
        entry.emitIndex += 1;
      }
      if (!entry.done) return;
      nextOutputIndex += 1;
    }
  };
  const index = (value) => { requireValue(Number.isSafeInteger(value) && value >= 0 && value < 1024); return value; };
  const live = (event, type) => {
    const entry = items.get(index(event.output_index));
    requireValue(entry && !entry.done && entry.initial.type === type && (event.item_id === undefined || event.item_id === entry.initial.id), 'MODEL_PROTOCOL_ERROR', 'Responses event did not match a live output item.');
    return entry;
  };
  const partFor = (entry, event, type) => {
    const position = index(event.content_index ?? 0); let part = entry.parts.get(position);
    if (!part) { part = { type, text: '', seen: false, textDone: false, done: false }; entry.parts.set(position, part); }
    requireValue(part.type === type && !part.done, 'MODEL_PROTOCOL_ERROR', 'Responses content event did not match its live part.'); return part;
  };
  const checkArguments = (value) => { requireValue(typeof value === 'string'); requireValue(bytes(value) <= context.limits.maxArgumentsBytes, 'MODEL_LIMIT_EXCEEDED', 'Tool arguments exceed their byte limit.'); };
  for await (const frame of readSse(response, context)) {
    const event = parseJson(frame.data); requireValue(record(event) && typeof event.type === 'string' && (!frame.event || frame.event === event.type));
    if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.cancelled') requireValue(false, 'MODEL_PROTOCOL_ERROR', 'The Responses stream failed before completion.');
    if (event.type === 'response.output_item.added') {
      const position = index(event.output_index); requireValue(!items.has(position) && record(event.item)); const initial = structuredClone(event.item);
      requireValue(['message', 'function_call'].includes(initial.type), 'MODEL_FEATURE_UNSUPPORTED', 'This Responses output item is unsupported.');
      sameIdentity(initial, initial);
      const entry = { initial, item: initial, done: false, emitIndex: 0, arguments: initial.arguments ?? '', argumentsSeen: Boolean(initial.arguments), argumentsDone: false, parts: new Map() };
      if (initial.type === 'function_call') { requireValue(typeof initial.call_id === 'string' && initial.call_id.length > 0 && typeof initial.name === 'string'); checkArguments(entry.arguments); }
      else for (const [position, part] of initial.content.entries()) {
        requireValue(record(part) && ['output_text', 'refusal'].includes(part.type), 'MODEL_FEATURE_UNSUPPORTED'); const text = part[part.type === 'refusal' ? 'refusal' : 'text'] ?? ''; requireValue(typeof text === 'string');
        entry.parts.set(position, { type: part.type, text, seen: Boolean(text), textDone: false, done: false });
      }
      items.set(position, entry);
    } else if (event.type === 'response.content_part.added') {
      const entry = live(event, 'message'); const position = index(event.content_index); requireValue(!entry.parts.has(position) && record(event.part));
      requireValue(['output_text', 'refusal'].includes(event.part.type), 'MODEL_FEATURE_UNSUPPORTED', 'This Responses content part is unsupported.');
      const text = event.part[event.part.type === 'refusal' ? 'refusal' : 'text'] ?? ''; requireValue(typeof text === 'string');
      entry.parts.set(position, { type: event.part.type, text, seen: Boolean(text), textDone: false, done: false });
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const type = event.type === 'response.refusal.delta' ? 'refusal' : 'output_text'; const part = partFor(live(event, 'message'), event, type);
      requireValue(!part.textDone && typeof event.delta === 'string'); part.seen = true; part.text += event.delta;
    } else if (event.type === 'response.output_text.done' || event.type === 'response.refusal.done') {
      const type = event.type === 'response.refusal.done' ? 'refusal' : 'output_text'; const part = partFor(live(event, 'message'), event, type); const text = event[type === 'refusal' ? 'refusal' : 'text'];
      requireValue(!part.textDone && typeof text === 'string' && (!part.seen || part.text === text), 'MODEL_PROTOCOL_ERROR', 'Responses completed text did not match its fragments.');
      part.text = text; part.seen = true; part.textDone = true;
    } else if (event.type === 'response.content_part.done') {
      const entry = live(event, 'message'); requireValue(record(event.part)); const part = partFor(entry, event, event.part.type); const text = event.part[part.type === 'refusal' ? 'refusal' : 'text'];
      requireValue(typeof text === 'string' && (!part.seen || part.text === text), 'MODEL_PROTOCOL_ERROR', 'Responses completed part did not match its fragments.');
      part.text = text; part.seen = true; part.done = true;
    } else if (event.type === 'response.function_call_arguments.delta') {
      const entry = live(event, 'function_call'); requireValue(!entry.argumentsDone && typeof event.delta === 'string'); entry.argumentsSeen = true; entry.arguments += event.delta; checkArguments(entry.arguments);
    } else if (event.type === 'response.function_call_arguments.done') {
      const entry = live(event, 'function_call'); checkArguments(event.arguments);
      requireValue(!entry.argumentsDone && (!entry.argumentsSeen || event.arguments === entry.arguments), 'MODEL_PROTOCOL_ERROR', 'Responses completed arguments did not match their fragments.');
      entry.arguments = event.arguments; entry.argumentsSeen = true; entry.argumentsDone = true;
    } else if (event.type === 'response.output_item.done') {
      const entry = items.get(index(event.output_index)); requireValue(entry && !entry.done); sameIdentity(entry.initial, event.item);
      if (entry.initial.type === 'function_call') { checkArguments(event.item.arguments); requireValue(!entry.argumentsSeen || event.item.arguments === entry.arguments, 'MODEL_PROTOCOL_ERROR', 'Responses arguments did not match their completed item.'); }
      else {
        verifyParts(entry, event.item);
        for (const [position, actual] of event.item.content.entries()) {
          requireValue(record(actual) && ['output_text', 'refusal'].includes(actual.type), 'MODEL_FEATURE_UNSUPPORTED');
          const text = actual[actual.type === 'refusal' ? 'refusal' : 'text']; requireValue(typeof text === 'string');
          const part = entry.parts.get(position) || { type: actual.type, emittedLength: 0 };
          Object.assign(part, { text, seen: true, textDone: true, done: true }); entry.parts.set(position, part);
        }
      }
      entry.item = structuredClone(event.item); entry.done = true;
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      raw = event.response; requireValue(raw?.status === (event.type === 'response.completed' ? 'completed' : 'incomplete')); terminal = true; break;
    } else if (event.type === 'response.output_text.annotation.added') { live(event, 'message'); }
    else if (!['response.created', 'response.in_progress', 'response.queued'].includes(event.type)) requireValue(false, 'MODEL_FEATURE_UNSUPPORTED', 'This Responses stream event requires an unsupported model feature.');
    flushText();
  }
  context.check(); requireValue(terminal, 'MODEL_PROTOCOL_ERROR', 'The Responses stream ended without a terminal response.');
  const final = normalize(raw);
  requireValue(items.size === 0 || items.size === raw.output.length, 'MODEL_PROTOCOL_ERROR', 'Responses terminal output has missing streamed items.');
  for (const [position, entry] of items) {
    const item = raw.output[position]; requireValue(entry.done, 'MODEL_PROTOCOL_ERROR', 'Responses terminal output includes an unfinished streamed item.'); sameIdentity(entry.initial, item);
    if (item.type === 'function_call') requireValue(item.arguments === entry.item.arguments && (!entry.argumentsSeen || item.arguments === entry.arguments), 'MODEL_PROTOCOL_ERROR', 'Responses terminal arguments did not match their completed item.');
    else { verifyParts(entry, item); requireValue(item.content.length === entry.item.content.length && item.content.every((part, index) => part.type === entry.item.content[index].type && part[part.type === 'refusal' ? 'refusal' : 'text'] === entry.item.content[index][part.type === 'refusal' ? 'refusal' : 'text']), 'MODEL_PROTOCOL_ERROR', 'Responses terminal text did not match its completed item.'); }
  }
  if (!emitted) emit(context.onEvent, final.content);
  return raw;
}
async function invoke(options) {
  const { binding, messages, tools, request, providerState, headers, url, context, fetchFn, onAttempt } = options;
  const input = prepareInput(binding, messages, providerState);
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const body = { model: binding.model, input, store: false, stream: request.stream, max_output_tokens: request.maxOutputTokens };
  if (system.length) body.instructions = system.join('\n\n'); if (request.temperature !== undefined) body.temperature = request.temperature;
  if (tools.length) body.tools = tools.map((t) => ({ type: 'function', ...t }));
  // Continuation may include opaque output items that are absent from the
  // normalized history; budget the actual stateless input before any request.
  const window = binding.capabilities.contextWindow?.tokens;
  if (window !== null && window !== undefined) requireValue(Math.ceil(JSON.stringify({ input, instructions: body.instructions, tools: body.tools }).length / 4) + request.maxOutputTokens <= window, 'MODEL_CONTEXT_LIMIT', 'The request and reserved output exceed the configured context window.');
  const response = await postJson({ url, body, headers, fetchFn, context, onAttempt });
  const raw = request.stream ? await readStream(response, context) : await readJson(response, context);
  context.check(); const turn = normalize(raw);
  // Streaming identity/terminal checks finish in readStream before an empty
  // completed turn can retain upstream usage as MODEL_EMPTY_RESPONSE.
  requireOutput(turn, context);
  if (!request.stream) emit(context.onEvent, turn.content);
  const token = Object.freeze({}); STATES.set(token, { binding, messages: structuredClone(messages), input: structuredClone(input), output: structuredClone(raw.output), turn: { content: turn.content, toolCalls: structuredClone(turn.toolCalls) } });
  return { ...turn, providerState: token };
}
module.exports = { invoke, invalidate, encodeMessages };
