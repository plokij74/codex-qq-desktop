'use strict';

function buildChatPayload(model, messages, extra = {}) {
  const body = { model, messages };
  if (extra.defaultTemperature !== false || extra.temperature !== undefined) body.temperature = extra.temperature ?? 0.7;
  if (extra.tools) body.tools = extra.tools;
  if (extra.tool_choice) body.tool_choice = extra.tool_choice;
  if (extra.stop !== undefined) body.stop = extra.stop;
  if (extra.maxTokens !== undefined) body[extra.maxTokenField || 'max_tokens'] = extra.maxTokens;
  if (extra.stream) body.stream = true;
  if (extra.stream && extra.includeUsage !== false) body.stream_options = { include_usage: true };
  return body;
}

function normalizeBaseUrl(baseUrl) {
  let root = String(baseUrl || '').trim();
  if (!root) throw new Error('Base URL 为空，请在设置中填写，例如 https://api.openai.com/v1');
  return root.replace(/\/+$/, '').replace(/\/chat\/completions$/i, '').replace(/\/+$/, '');
}
function looksLikeHtml(text) {
  const value = String(text || '').trim().slice(0, 200).toLowerCase();
  return value.startsWith('<!doctype') || value.startsWith('<html') || value.includes('<head') || value.includes('<body');
}
function finish(reason) {
  const reasons = { stop: 'stop', tool_calls: 'tool_calls', length: 'length', content_filter: 'filtered' };
  return typeof reason === 'string' && Object.hasOwn(reasons, reason) ? reasons[reason] : 'unknown';
}

/** One Chat wire implementation. E4 owns its context, credentials and strict policy;
 * deprecated public helpers use the same wire with their historical result shape.
 */
async function invokeChatCompletionWire({ body, url, headers, context, fetchFn, onAttempt = () => {}, strict = true, rawResult = false }) {
  const { requireValue, record, parseJson, bytes, emit } = require('./model-adapters/common');
  const { postJson, readJson, readSse } = require('./model-adapters/transport');
  const response = await postJson({ url, body, headers, context, fetchFn, onAttempt });
  if (!body.stream) {
    const raw = await readJson(response, context);
    if (rawResult) return raw;
    requireValue(record(raw) && !raw.error && Array.isArray(raw.choices) && raw.choices.length === 1);
    const choice = raw.choices[0]; requireValue(record(choice)); const message = choice.message;
    requireValue(record(message) && (message.role === undefined || message.role === 'assistant')
      && (message.content === null || message.content === undefined || typeof message.content === 'string')
      && (message.refusal === null || message.refusal === undefined || typeof message.refusal === 'string'));
    const calls = message.tool_calls === undefined ? [] : message.tool_calls;
    requireValue(Array.isArray(calls));
    const content = message.content || '';
    const toolCalls = calls.map(call => {
      requireValue(record(call) && call.type === 'function' && record(call.function));
      return { id: call.id, name: call.function.name, argumentsJson: call.function.arguments };
    });
    const finishReason = typeof message.refusal === 'string' && message.refusal ? 'filtered' : finish(choice.finish_reason);
    requireValue(!strict || finishReason !== 'unknown');
    requireValue(finishReason !== 'tool_calls' || toolCalls.length > 0);
    if (strict && !content.length && !toolCalls.length && !['filtered', 'length'].includes(finishReason)) {
      context.validatedUsage = raw.usage;
      requireValue(false, 'MODEL_EMPTY_RESPONSE', 'The model returned no text or tool calls.');
    }
    emit(context.onEvent, content);
    return { content, toolCalls, finishReason, rawUsage: raw.usage, legacyFinishReason: choice.finish_reason };
  }

  let content = ''; let finishReason = 'unknown'; let legacyFinishReason; let rawUsage; let terminal = false; let refused = false;
  const calls = new Map();
  for await (const frame of readSse(response, context)) {
    if (frame.data === '[DONE]') { terminal = true; break; }
    const raw = parseJson(frame.data);
    requireValue(record(raw) && !raw.error && Array.isArray(raw.choices) && raw.choices.length <= 1);
    if (raw.usage) rawUsage = raw.usage;
    for (const choice of raw.choices) {
      requireValue(record(choice) && (choice.index === undefined || choice.index === 0));
      const delta = choice.delta || {};
      requireValue(record(delta) && (delta.role === undefined || delta.role === 'assistant'));
      requireValue(delta.refusal === undefined || delta.refusal === null || typeof delta.refusal === 'string');
      requireValue(finishReason === 'unknown' || (!delta.content && !delta.refusal && (delta.tool_calls === undefined || Array.isArray(delta.tool_calls) && delta.tool_calls.length === 0)),
        'MODEL_PROTOCOL_ERROR', 'The Chat stream added content after its terminal finish reason.');
      if (delta.refusal) refused = true;
      if (delta.content !== undefined && delta.content !== null) {
        requireValue(typeof delta.content === 'string'); content += delta.content; emit(context.onEvent, delta.content);
      }
      if (delta.tool_calls !== undefined) {
        requireValue(Array.isArray(delta.tool_calls));
        for (const part of delta.tool_calls) {
          requireValue(record(part));
          const index = part.index; requireValue(Number.isSafeInteger(index) && index >= 0 && index < 256);
          const call = calls.get(index) || { id: '', name: '', argumentsJson: '' }; calls.set(index, call);
          if (part.id !== undefined) { requireValue(typeof part.id === 'string' && (!call.id || call.id === part.id)); call.id = part.id; }
          requireValue(part.type === undefined || part.type === 'function');
          if (part.function !== undefined) requireValue(record(part.function));
          if (part.function?.name !== undefined) { requireValue(typeof part.function.name === 'string'); call.name += part.function.name; }
          if (part.function?.arguments !== undefined) {
            requireValue(typeof part.function.arguments === 'string'); call.argumentsJson += part.function.arguments;
            requireValue(bytes(call.argumentsJson) <= context.limits.maxArgumentsBytes, 'MODEL_LIMIT_EXCEEDED', 'Tool arguments exceed their byte limit.');
          }
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        const next = finish(choice.finish_reason);
        requireValue(next !== 'unknown' && (finishReason === 'unknown' || finishReason === next));
        finishReason = next; legacyFinishReason = choice.finish_reason;
      }
    }
  }
  context.check();
  requireValue(!strict || terminal && finishReason !== 'unknown', 'MODEL_PROTOCOL_ERROR', 'The Chat stream did not include a complete terminal event.');
  if (refused) finishReason = 'filtered';
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
  requireValue(finishReason !== 'tool_calls' || toolCalls.length > 0);
  if (strict && !content.length && !toolCalls.length && !['length', 'filtered'].includes(finishReason)) {
    context.validatedUsage = rawUsage;
    requireValue(false, 'MODEL_EMPTY_RESPONSE', 'The model returned no text or tool calls.');
  }
  return { content, toolCalls, finishReason, rawUsage, legacyFinishReason };
}

async function legacyRequest(opts, rawResult = false) {
  const { LIMITS } = require('./model-adapters/common');
  const { createRequestContext } = require('./model-adapters/transport');
  if (!opts.model) throw new Error('Model 为空，请在设置中填写模型名');
  const context = createRequestContext({ signal: opts.signal, timeoutMs: LIMITS.timeoutMs, limits: LIMITS,
    onEvent: typeof opts.onDelta === 'function' ? event => { if (event.type === 'text-delta') opts.onDelta({ text: event.delta }); } : undefined });
  try {
    return await invokeChatCompletionWire({ body: buildChatPayload(opts.model, opts.messages, { ...opts, stream: !rawResult && !!opts.stream }),
      url: `${normalizeBaseUrl(opts.baseUrl)}/chat/completions`, headers: { Authorization: `Bearer ${opts.apiKey || ''}` },
      fetchFn: opts.fetchFn, context, strict: false, rawResult });
  } catch (error) {
    if (error.code === 'ABORTED') error.message = '已停止';
    throw error;
  } finally { await context.dispose(); }
}
async function chatRequest(opts) { return legacyRequest(opts, true); }
async function chatCompletionMessage(opts) {
  const result = await legacyRequest(opts);
  return { role: 'assistant', content: result.content,
    tool_calls: result.toolCalls.length ? result.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.argumentsJson } })) : undefined,
    usage: result.rawUsage, ...(result.legacyFinishReason != null ? { finishReason: result.legacyFinishReason } : {}) };
}
async function chatCompletion(opts) {
  const message = await chatCompletionMessage(opts);
  if (!message.content && !message.tool_calls?.length) throw new Error('API 返回空内容');
  return message.content || '';
}
module.exports = { buildChatPayload, chatCompletion, chatCompletionMessage, chatRequest, normalizeBaseUrl, looksLikeHtml, invokeChatCompletionWire };
